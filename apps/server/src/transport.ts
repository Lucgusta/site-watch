import { Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { checkServerIdentity } from "node:tls";
import ipaddr from "ipaddr.js";

export type ErrorCategory =
  | "DNS"
  | "CONNECTION"
  | "TLS"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "INTERNAL"
  | "BLOCKED"
  | "REDIRECT_LIMIT";

export type CheckResult = {
  success: boolean;
  httpStatus: number | null;
  responseTimeMs: number | null;
  elapsedMs: number;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
};

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type HeaderResponse = {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  destroy(): unknown;
};

export type RequestHandle = {
  on(event: "error", listener: (error: Error) => void): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
};

/** Injectable I/O for deterministic tests; target validation always runs. */
export type TransportDependencies = {
  resolve?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<ResolvedAddress[]>;
  request?: (
    options: RequestOptions,
    onResponse: (response: HeaderResponse) => void,
  ) => RequestHandle;
  now?: () => number;
};

class TransportError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NO_DNS_RECORD = new Set(["ENODATA", "ENOTFOUND"]);
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EPIPE",
  "ERR_SOCKET_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const GLOBAL_IPV6 = ipaddr.IPv6.parseCIDR("2000::/3");
// Conservative exclusions supplement ipaddr.js's built-in special ranges.
// Transition/tunnel addresses must not provide an indirect route to private IPv4.
const SPECIAL_IPV6 = [
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}

function hostnameOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function assertPublicAddress(address: string): ResolvedAddress {
  // DNS answers must be literal addresses, never another hostname or scoped IP.
  const family = isIP(address);
  if ((family !== 4 && family !== 6) || address.includes("%")) {
    throw new TransportError(
      "BLOCKED",
      "The target resolved to an invalid IP address.",
    );
  }
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== "unicast" || address === "168.63.129.16") {
    throw new TransportError(
      "BLOCKED",
      "Only publicly routable IP addresses are allowed.",
    );
  }
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (
      !ipv6.match(GLOBAL_IPV6) ||
      SPECIAL_IPV6.some((range) => ipv6.match(range))
    ) {
      throw new TransportError(
        "BLOCKED",
        "Special-use and tunnel IPv6 addresses are not allowed.",
      );
    }
    // ISATAP embeds IPv4 in otherwise ordinary global IPv6 prefixes.
    if ((ipv6.parts[4]! & 0xfdff) === 0 && ipv6.parts[5] === 0x5efe) {
      throw new TransportError(
        "BLOCKED",
        "IPv6 transition addresses are not allowed.",
      );
    }
  }
  return { address: parsed.toString(), family };
}

/** Validate a target without performing network I/O. DNS is validated per check. */
export function validateUrl(input: string): URL {
  if (
    typeof input !== "string" ||
    input.length > 2_048 ||
    Array.from(input).some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127 ||
        character === "\\",
    )
  ) {
    throw new TransportError(
      "BLOCKED",
      "Enter a valid HTTP or HTTPS URL without spaces or control characters.",
    );
  }
  if (!/^https?:\/\//i.test(input)) {
    throw new TransportError(
      "BLOCKED",
      "Only HTTP and HTTPS URLs are allowed.",
    );
  }
  let url: URL;
  try {
    // WHATWG URL normalizes hexadecimal, octal, integer and percent-encoded IPv4.
    url = new URL(input);
  } catch {
    throw new TransportError("BLOCKED", "Enter a valid HTTP or HTTPS URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new TransportError(
      "BLOCKED",
      "URLs must use HTTP or HTTPS and must not contain credentials.",
    );
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new TransportError("BLOCKED", "Only ports 80 and 443 are allowed.");
  }
  const hostname = hostnameOf(url);
  if (isIP(hostname)) {
    assertPublicAddress(hostname);
  } else if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname,
    ) ||
    hostname.split(".").includes("localhost") ||
    /\.(?:local|localdomain|internal|lan|home|arpa)$/.test(hostname)
  ) {
    throw new TransportError(
      "BLOCKED",
      "Local and special-use hostnames are not allowed.",
    );
  }
  url.hash = "";
  return url;
}

/** Resolve both families together; cancel actual DNS queries at the attempt deadline. */
async function resolvePublicHost(
  hostname: string,
  signal: AbortSignal,
): Promise<ResolvedAddress[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses: ResolvedAddress[] = [];
    for (const [index, answer] of answers.entries()) {
      if (answer.status === "fulfilled") {
        addresses.push(
          ...answer.value.map((address) => ({
            address,
            family: index === 0 ? (4 as const) : (6 as const),
          })),
        );
      } else if (!NO_DNS_RECORD.has(errorCode(answer.reason))) {
        throw new TransportError("DNS", "DNS resolution failed.");
      }
    }
    if (!addresses.length)
      throw new TransportError("DNS", "The hostname has no A or AAAA records.");
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function classifyError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  const code = errorCode(error);
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new TransportError(
      "TIMEOUT",
      "The total check timeout was reached.",
    );
  }
  if (
    code === "EPROTO" ||
    /^(?:ERR_TLS_|ERR_SSL_)/.test(code) ||
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)
  ) {
    return new TransportError(
      "TLS",
      "TLS certificate validation or negotiation failed.",
    );
  }
  if (CONNECTION_CODES.has(code) || code.startsWith("HPE_")) {
    return new TransportError(
      "CONNECTION",
      "The connection failed before final response headers arrived.",
    );
  }
  return new TransportError(
    "INTERNAL",
    "The monitor could not complete this check.",
  );
}

function requestHeaders(
  url: URL,
  pinned: ResolvedAddress,
  signal: AbortSignal,
  makeRequest: NonNullable<TransportDependencies["request"]>,
  now: () => number,
): Promise<{ httpStatus: number; location?: string; receivedAt: number }> {
  return new Promise((resolve, reject) => {
    let request: RequestHandle | undefined;
    let completed = false;
    const finish = (
      error?: unknown,
      result?: { httpStatus: number; location?: string; receivedAt: number },
    ) => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => {
      finish(signal.reason);
      request?.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    const hostname = hostnameOf(url);
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      protocol: url.protocol,
      hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      family: pinned.family,
      autoSelectFamily: false,
      // No second DNS lookup: only the already validated address reaches the socket.
      lookup: (_host, _options, callback) =>
        callback(null, pinned.address, pinned.family),
      servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: true,
      checkServerIdentity,
      maxHeaderSize: 16 * 1_024,
      headers: {
        "user-agent": "Site-Watch/1.0",
        accept: "*/*",
        connection: "close",
      },
    };
    try {
      request = makeRequest(options, (response) => {
        const receivedAt = now();
        const httpStatus = response.statusCode;
        const location = response.headers.location;
        // Receiving headers completes the observation. Never download or buffer the page.
        response.destroy();
        if (completed) return;
        if (!httpStatus) {
          finish(
            new TransportError(
              "CONNECTION",
              "The server returned invalid HTTP response headers.",
            ),
          );
        } else {
          finish(undefined, {
            httpStatus,
            receivedAt,
            ...(typeof location === "string" ? { location } : {}),
          });
        }
        request?.destroy();
      });
      // Keep this listener attached through cleanup to consume socket errors after cancellation.
      request.on("error", (error) => {
        if (completed) return;
        finish(error);
        request?.destroy();
      });
      if (completed) {
        request.destroy();
        return;
      }
      request.end();
    } catch (error) {
      finish(error);
      request?.destroy();
    }
  });
}

/** Header-only GET using a single monotonic deadline across DNS and up to five redirects. */
export async function checkUrl(
  input: string,
  timeoutMs: number,
  dependencies: TransportDependencies = {},
): Promise<CheckResult> {
  const now = dependencies.now ?? (() => performance.now());
  const start = now();
  const elapsed = () => Math.max(0, Math.round(now() - start));
  const controller = new AbortController();
  const timeoutError = new TransportError(
    "TIMEOUT",
    "The total check timeout was reached.",
  );
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    Math.max(1, Math.min(timeoutMs, 120_000)),
  );
  const resolve = dependencies.resolve ?? resolvePublicHost;
  const request =
    dependencies.request ??
    ((options, callback) =>
      options.protocol === "https:"
        ? httpsRequest(options, callback)
        : httpRequest(options, callback));
  try {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new TransportError(
        "INTERNAL",
        "The configured timeout is invalid.",
      );
    }
    let url = validateUrl(input);
    for (let redirects = 0; ; redirects += 1) {
      if (now() - start >= timeoutMs) controller.abort(timeoutError);
      controller.signal.throwIfAborted();
      const hostname = hostnameOf(url);
      let addresses: ResolvedAddress[];
      if (isIP(hostname)) {
        addresses = [assertPublicAddress(hostname)];
      } else {
        try {
          addresses = await withAbort(
            resolve(hostname, controller.signal),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof TransportError) throw error;
          throw new TransportError("DNS", "DNS resolution failed.");
        }
      }
      if (!addresses.length)
        throw new TransportError(
          "DNS",
          "The hostname has no A or AAAA records.",
        );
      // Fail closed if ANY answer is forbidden, including unused AAAA records.
      const validated = addresses.map(({ address, family }) => {
        const literal = assertPublicAddress(address);
        if (literal.family !== family)
          throw new TransportError(
            "BLOCKED",
            "DNS returned an invalid address family.",
          );
        return literal;
      });
      if (now() - start >= timeoutMs) controller.abort(timeoutError);
      controller.signal.throwIfAborted();
      const pinned =
        validated.find((address) => address.family === 4) ?? validated[0]!;
      const response = await requestHeaders(
        url,
        pinned,
        controller.signal,
        request,
        now,
      );
      if (response.receivedAt - start >= timeoutMs)
        controller.abort(timeoutError);
      controller.signal.throwIfAborted();
      if (REDIRECT_STATUSES.has(response.httpStatus) && response.location) {
        if (redirects >= 5)
          throw new TransportError(
            "REDIRECT_LIMIT",
            "The server exceeded the limit of five redirects.",
          );
        try {
          url = validateUrl(new URL(response.location, url).toString());
        } catch (error) {
          if (error instanceof TransportError) throw error;
          throw new TransportError(
            "BLOCKED",
            "The server redirected to an invalid URL.",
          );
        }
        continue;
      }
      const elapsedMs = Math.max(0, Math.round(response.receivedAt - start));
      const success = response.httpStatus >= 200 && response.httpStatus <= 299;
      return {
        success,
        httpStatus: response.httpStatus,
        responseTimeMs: elapsedMs,
        elapsedMs,
        errorCategory: success ? null : "HTTP_STATUS",
        errorMessage: success
          ? null
          : `Unexpected HTTP status ${response.httpStatus}.`,
      };
    }
  } catch (error) {
    const failure = classifyError(
      controller.signal.aborted ? controller.signal.reason : error,
    );
    return {
      success: false,
      httpStatus: null,
      responseTimeMs: null,
      elapsedMs: elapsed(),
      errorCategory: failure.category,
      errorMessage: failure.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
