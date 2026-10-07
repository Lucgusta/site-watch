import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
const env = {
  DATABASE_URL: "postgresql://test:test@localhost/test",
  APP_ORIGIN: "http://localhost:3000",
  ADMIN_USERNAME: "owner",
  ADMIN_PASSWORD_HASH: `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`,
  SESSION_SECRET: "c".repeat(32),
};
describe("configuration validation", () => {
  it("allows email to be left unconfigured", () => {
    expect(loadConfig(env).smtp).toBeUndefined();
  });
  it("fails closed when admin credentials are absent or production uses HTTP", () => {
    expect(() => loadConfig({ ...env, ADMIN_PASSWORD_HASH: "" })).toThrow();
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow(
      /HTTPS/,
    );
  });
  it("requires a real origin rather than a path or credentials", () => {
    expect(() =>
      loadConfig({ ...env, APP_ORIGIN: "http://localhost:3000/app" }),
    ).toThrow(/origin/);
  });
  it("validates email configuration rather than silently failing", () => {
    expect(() =>
      loadConfig({
        ...env,
        SMTP_HOST: "mail.example.com",
        SMTP_FROM: "invalid",
      }),
    ).toThrow();
  });
});
