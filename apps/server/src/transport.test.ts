import { EventEmitter } from "node:events";
import { Resolver } from "node:dns/promises";
import type { RequestOptions } from "node:https";
import { checkServerIdentity } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkUrl,
  validateUrl,
  type HeaderResponse,
  type RequestHandle,
  type ResolvedAddress,
  type TransportDependencies,
} from "./transport.js";

const PUBLIC_V4: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: ResolvedAddress = {
  address: "2606:4700:4700::1111",
  family: 6,
};

type PlannedResponse = {
  status?: number;
  location?: string;
  error?: Error;
  delay?: number;
  hanging?: boolean;
};

function codedError(code: string): Error {
  return Object.assign(
    new Error("Sensitive remote details must not be exposed"),
    { code },
  );
}

function fixture(plan: PlannedResponse[] = [{ status: 200 }]) {
  let tick = 0;
  const options: RequestOptions[] = [];
  const handles: Array<RequestHandle & { destroy: ReturnType<typeof vi.fn> }> =
    [];
  const bodies: Array<HeaderResponse & { destroy: ReturnType<typeof vi.fn> }> =
    [];
  const resolve = vi.fn(
    async (): Promise<ResolvedAddress[]> => [PUBLIC_V4, PUBLIC_V6],
  );
  const request: NonNullable<TransportDependencies["request"]> = (
    requestOptions,
    callback,
  ) => {
    options.push(requestOptions);
    const item = plan[options.length - 1] ?? { status: 200 };
    const emitter = new EventEmitter();
    const handle = {
      on: (event: "error", listener: (error: Error) => void) =>
        emitter.on(event, listener),
      destroy: vi.fn(),
      end: () => {
        if (item.hanging) return;
        queueMicrotask(() => {
          tick += item.delay ?? 25;
          if (item.error) {
            emitter.emit("error", item.error);
          } else {
            const response = {
              statusCode: item.status,
              headers: item.location ? { location: item.location } : {},
              destroy: vi.fn(),
            };
            bodies.push(response);
            callback(response);
          }
        });
      },
    };
    handles.push(handle);
    return handle;
  };
  return {
    dependencies: { resolve, request, now: () => tick },
    options,
    handles,
    bodies,
    resolve,
    advance: (ms: number) => {
      tick += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("validateUrl SSRF target policy", () => {
  it.each([
    "https://example.com/path?query=1",
    "http://8.8.8.8/",
    "https://[2606:4700:4700::1111]/",
    "https://example.com:80/",
    "http://example.com:443/",
    "https://xn--bcher-kva.de/",
  ])("accepts public HTTP target %s", (input) => {
    expect(validateUrl(input)).toBeInstanceOf(URL);
  });

  it("omits the fragment, which is never sent to the server", () => {
    expect(validateUrl("https://example.com/#fragment").toString()).toBe(
      "https://example.com/",
    );
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "http:example.com",
    "https://user:password@example.com/",
    "https://example.com:8080/",
    "http://localhost/",
    "http://localhost./",
    "http://LOCALHOST.example.com/",
    "http://app.localhost/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    "http://intranet/",
    "http://127.0.0.1/",
    "http://127.255.0.1/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://100.100.100.200/",
    "http://168.63.129.16/",
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://127.1/",
    "http://%31%32%37.0.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[64:ff9b::a00:1]/",
    "http://[64:ff9b:1::a00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
    "http://[2001:db8::1]/",
    "http://[3fff::1]/",
    "http://[2606:4700:0:0:0:5efe:7f00:1]/",
    "http://[2606:4700:0:0:200:5efe:7f00:1]/",
    "http://example.com/\npath",
    "http://example.com\\@127.0.0.1/",
  ])("blocks local, reserved or ambiguous target %s", (input) => {
    expect(() => validateUrl(input)).toThrow();
  });
});

describe("checkUrl controlled HTTP observations", () => {
  it("records final response headers and immediately frees the body and request", async () => {
    const test = fixture([{ status: 204, delay: 48 }]);
    const result = await checkUrl(
      "https://example.com/health?test=1",
      1_000,
      test.dependencies,
    );
    expect(result).toEqual({
      success: true,
      httpStatus: 204,
      responseTimeMs: 48,
      elapsedMs: 48,
      errorCategory: null,
      errorMessage: null,
    });
    expect(test.options[0]).toMatchObject({
      hostname: "example.com",
      servername: "example.com",
      method: "GET",
      path: "/health?test=1",
      rejectUnauthorized: true,
      agent: false,
      autoSelectFamily: false,
      family: 4,
      maxHeaderSize: 16_384,
    });
    expect(test.options[0].checkServerIdentity).toBe(checkServerIdentity);
    expect(test.bodies[0].destroy).toHaveBeenCalledOnce();
    expect(test.handles[0].destroy).toHaveBeenCalledOnce();
  });

  it("pins the validated address without a second DNS resolution", async () => {
    const test = fixture();
    test.resolve
      .mockResolvedValueOnce([PUBLIC_V4])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await checkUrl("https://example.com/", 1_000, test.dependencies);
    const callback = vi.fn();
    test.options[0].lookup!("example.com", { family: 4 }, callback);
    expect(callback).toHaveBeenCalledWith(null, PUBLIC_V4.address, 4);
    expect(test.resolve).toHaveBeenCalledTimes(1);
    // A subsequent attempt must resolve again and block changed DNS answers.
    const second = await checkUrl(
      "https://example.com/",
      1_000,
      test.dependencies,
    );
    expect(second.errorCategory).toBe("BLOCKED");
    expect(test.options).toHaveLength(1);
  });

  it("validates unused AAAA answers before making any connection", async () => {
    const test = fixture();
    test.resolve.mockResolvedValueOnce([
      PUBLIC_V4,
      { address: "::ffff:10.0.0.1", family: 6 },
    ]);
    const result = await checkUrl(
      "https://example.com/",
      1_000,
      test.dependencies,
    );
    expect(result.errorCategory).toBe("BLOCKED");
    expect(test.options).toHaveLength(0);
  });

  it("pins IPv6 when no IPv4 answer exists and keeps the certificate hostname", async () => {
    const test = fixture();
    test.resolve.mockResolvedValueOnce([PUBLIC_V6]);
    await checkUrl("https://example.com/", 1_000, test.dependencies);
    const callback = vi.fn();
    test.options[0].lookup!("example.com", { family: 6 }, callback);
    expect(callback).toHaveBeenCalledWith(null, PUBLIC_V6.address, 6);
    expect(test.options[0].servername).toBe("example.com");
  });

  it("does not perform DNS for a validated public literal", async () => {
    const test = fixture();
    const result = await checkUrl("https://8.8.8.8/", 1_000, test.dependencies);
    expect(result.success).toBe(true);
    expect(test.resolve).not.toHaveBeenCalled();
    expect(test.options[0].servername).toBeUndefined();
    expect(test.options[0].rejectUnauthorized).toBe(true);
  });

  it("records unexpected HTTP statuses as a measured HTTP response", async () => {
    const test = fixture([{ status: 503, delay: 72 }]);
    const result = await checkUrl(
      "https://example.com/",
      1_000,
      test.dependencies,
    );
    expect(result).toMatchObject({
      success: false,
      httpStatus: 503,
      responseTimeMs: 72,
      elapsedMs: 72,
      errorCategory: "HTTP_STATUS",
    });
  });

  it.each([
    ["ECONNREFUSED", "CONNECTION"],
    ["ECONNRESET", "CONNECTION"],
    ["HPE_INVALID_HEADER_TOKEN", "CONNECTION"],
    ["CERT_HAS_EXPIRED", "TLS"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "TLS"],
    ["EPROTO", "TLS"],
    ["ETIMEDOUT", "TIMEOUT"],
    ["UNKNOWN_BUG", "INTERNAL"],
  ])(
    "classifies %s as %s without a fabricated response time",
    async (code, category) => {
      const test = fixture([{ error: codedError(code), delay: 85 }]);
      const result = await checkUrl(
        "https://example.com/",
        1_000,
        test.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        httpStatus: null,
        responseTimeMs: null,
        elapsedMs: 85,
        errorCategory: category,
      });
      expect(result.errorMessage).not.toContain("Sensitive");
    },
  );

  it("classifies failed DNS before attempting a request", async () => {
    const test = fixture();
    test.resolve.mockRejectedValueOnce(codedError("ENOTFOUND"));
    expect(
      (await checkUrl("https://example.com/", 1_000, test.dependencies))
        .errorCategory,
    ).toBe("DNS");
    expect(test.options).toHaveLength(0);
  });

  it("resolves A and AAAA with the production resolver and validates both families", async () => {
    const a = vi
      .spyOn(Resolver.prototype, "resolve4")
      .mockResolvedValue([PUBLIC_V4.address]);
    const aaaa = vi
      .spyOn(Resolver.prototype, "resolve6")
      .mockResolvedValue(["fd00::1"]);
    const test = fixture();
    const result = await checkUrl("https://example.com/", 1_000, {
      request: test.dependencies.request,
      now: test.dependencies.now,
    });
    expect(result.errorCategory).toBe("BLOCKED");
    expect(a).toHaveBeenCalledWith("example.com");
    expect(aaaa).toHaveBeenCalledWith("example.com");
    expect(test.options).toHaveLength(0);
  });

  it("accepts an absent AAAA record but fails closed when its DNS query fails", async () => {
    vi.spyOn(Resolver.prototype, "resolve4").mockResolvedValue([
      PUBLIC_V4.address,
    ]);
    const aaaa = vi
      .spyOn(Resolver.prototype, "resolve6")
      .mockRejectedValueOnce(codedError("ENODATA"));
    const test = fixture();
    const dependencies = {
      request: test.dependencies.request,
      now: test.dependencies.now,
    };
    expect(
      (await checkUrl("https://example.com/", 1_000, dependencies)).success,
    ).toBe(true);
    aaaa.mockRejectedValueOnce(codedError("ESERVFAIL"));
    expect(
      (await checkUrl("https://example.com/", 1_000, dependencies))
        .errorCategory,
    ).toBe("DNS");
    expect(test.options).toHaveLength(1);
  });

  it("rejects DNS responses with no addresses or mismatched address families", async () => {
    const empty = fixture();
    empty.resolve.mockResolvedValueOnce([]);
    expect(
      (await checkUrl("https://example.com/", 1_000, empty.dependencies))
        .errorCategory,
    ).toBe("DNS");
    const invalid = fixture();
    invalid.resolve.mockResolvedValueOnce([
      { address: PUBLIC_V4.address, family: 6 },
    ]);
    expect(
      (await checkUrl("https://example.com/", 1_000, invalid.dependencies))
        .errorCategory,
    ).toBe("BLOCKED");
    expect(invalid.options).toHaveLength(0);
  });

  it("rejects forbidden targets even with an injected public resolver", async () => {
    const test = fixture();
    expect(
      (await checkUrl("http://127.0.0.1/", 1_000, test.dependencies))
        .errorCategory,
    ).toBe("BLOCKED");
    expect(test.resolve).not.toHaveBeenCalled();
    expect(test.options).toHaveLength(0);
  });

  it("follows a relative redirect and measures all hops including DNS", async () => {
    const test = fixture([
      { status: 302, location: "/ready", delay: 30 },
      { status: 200, delay: 40 },
    ]);
    test.resolve.mockImplementation(async () => {
      test.advance(10);
      return [PUBLIC_V4];
    });
    const result = await checkUrl(
      "https://example.com/start",
      1_000,
      test.dependencies,
    );
    expect(result.responseTimeMs).toBe(90);
    expect(test.resolve).toHaveBeenCalledTimes(2);
    expect(test.options.map((options) => options.path)).toEqual([
      "/start",
      "/ready",
    ]);
    expect(
      test.bodies.every((body) => body.destroy.mock.calls.length === 1),
    ).toBe(true);
  });

  it("follows exactly five redirects but refuses a sixth", async () => {
    const five = fixture([
      ...Array.from({ length: 5 }, () => ({ status: 301, location: "/next" })),
      { status: 200 },
    ]);
    expect(
      (await checkUrl("https://example.com/", 1_000, five.dependencies))
        .success,
    ).toBe(true);
    expect(five.options).toHaveLength(6);
    const six = fixture(
      Array.from({ length: 6 }, () => ({ status: 301, location: "/next" })),
    );
    expect(
      (await checkUrl("https://example.com/", 1_000, six.dependencies))
        .errorCategory,
    ).toBe("REDIRECT_LIMIT");
    expect(six.options).toHaveLength(6);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
  ])("blocks redirect destination %s", async (location) => {
    const test = fixture([{ status: 302, location }]);
    expect(
      (await checkUrl("https://example.com/", 1_000, test.dependencies))
        .errorCategory,
    ).toBe("BLOCKED");
    expect(test.options).toHaveLength(1);
  });

  it("validates changed DNS on a same-host redirect", async () => {
    const test = fixture([{ status: 302, location: "/private" }]);
    test.resolve
      .mockResolvedValueOnce([PUBLIC_V4])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    expect(
      (await checkUrl("https://example.com/", 1_000, test.dependencies))
        .errorCategory,
    ).toBe("BLOCKED");
    expect(test.options).toHaveLength(1);
  });

  it("uses one total monotonic deadline across redirects", async () => {
    const test = fixture([
      { status: 302, location: "/next", delay: 700 },
      { status: 200, delay: 400 },
    ]);
    const result = await checkUrl(
      "https://example.com/",
      1_000,
      test.dependencies,
    );
    expect(result).toMatchObject({
      errorCategory: "TIMEOUT",
      responseTimeMs: null,
      elapsedMs: 1_100,
    });
  });

  it("aborts a hanging request at the total deadline and cleans up the timer", async () => {
    vi.useFakeTimers();
    const test = fixture([{ hanging: true }]);
    const promise = checkUrl("https://example.com/", 1_000, test.dependencies);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.handles).toHaveLength(1);
    test.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await promise).toMatchObject({
      errorCategory: "TIMEOUT",
      responseTimeMs: null,
      elapsedMs: 1_000,
    });
    expect(test.handles[0].destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts DNS and prevents a late DNS result from opening a connection", async () => {
    vi.useFakeTimers();
    const test = fixture();
    let finishDns: ((addresses: ResolvedAddress[]) => void) | undefined;
    let signal: AbortSignal | undefined;
    const dependencies: TransportDependencies = {
      ...test.dependencies,
      resolve: (_hostname, abortSignal) => {
        signal = abortSignal;
        return new Promise((resolve) => {
          finishDns = resolve;
        });
      },
    };
    const promise = checkUrl("https://example.com/", 1_000, dependencies);
    test.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await promise).toMatchObject({
      errorCategory: "TIMEOUT",
      elapsedMs: 1_000,
      responseTimeMs: null,
    });
    expect(signal?.aborted).toBe(true);
    finishDns!([PUBLIC_V4]);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.options).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending queries on the production DNS resolver when the total timeout expires", async () => {
    vi.useFakeTimers();
    const rejectPending: Array<(reason: unknown) => void> = [];
    vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending.push(reject);
        }),
    );
    vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending.push(reject);
        }),
    );
    const cancel = vi
      .spyOn(Resolver.prototype, "cancel")
      .mockImplementation(() => {
        rejectPending.forEach((reject) => reject(codedError("ECANCELLED")));
      });
    const test = fixture();
    const promise = checkUrl("https://example.com/", 1_000, {
      request: test.dependencies.request,
      now: test.dependencies.now,
    });
    test.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await promise).errorCategory).toBe("TIMEOUT");
    expect(cancel).toHaveBeenCalledOnce();
    expect(test.options).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
