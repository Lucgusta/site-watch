import type { Session } from "./types";

export async function api<T>(
  path: string,
  options?: { method?: string; body?: unknown; csrf?: string },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    method: options?.method ?? "GET",
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(options?.csrf ? { "x-csrf-token": options.csrf } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    let message = `The request failed (${response.status}). Please try again.`;
    try {
      const error = await response.json();
      message =
        typeof error.error === "string"
          ? error.error
          : (error.error?.message ?? error.message ?? message);
    } catch {
      /* Keep the readable fallback for a non-JSON response. */
    }
    if (response.status === 401)
      message =
        path === "/login"
          ? "The username or password is incorrect."
          : "Your session has expired. Sign in again to continue.";
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function login(username: string, password: string): Promise<Session> {
  return api("/login", { method: "POST", body: { username, password } });
}
