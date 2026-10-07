import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });
export interface Config {
  databaseUrl: string;
  origin: string;
  production: boolean;
  username: string;
  passwordHash: string;
  sessionSecret: string;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
  };
}
export function loadConfig(env = process.env): Config {
  const values = z
    .object({
      DATABASE_URL: z.string().min(1),
      APP_ORIGIN: z.url(),
      ADMIN_USERNAME: z.string().min(1).max(80),
      ADMIN_PASSWORD_HASH: z
        .string()
        .regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
      SESSION_SECRET: z.string().min(32),
    })
    .parse(env);
  const origin = new URL(values.APP_ORIGIN);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "APP_ORIGIN must be an HTTP(S) origin without a path or credentials.",
    );
  const production = env.NODE_ENV === "production";
  if (production && origin.protocol !== "https:")
    throw new Error(
      "Production APP_ORIGIN requires HTTPS. Use NODE_ENV=development only for local HTTP.",
    );
  const smtp = env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: z.coerce
          .number()
          .int()
          .min(1)
          .max(65535)
          .parse(env.SMTP_PORT ?? "587"),
        secure: env.SMTP_SECURE === "true",
        user: env.SMTP_USER || undefined,
        password: env.SMTP_PASSWORD || undefined,
        from: z.email().parse(env.SMTP_FROM),
      }
    : undefined;
  return {
    databaseUrl: values.DATABASE_URL,
    origin: origin.origin,
    production,
    username: values.ADMIN_USERNAME,
    passwordHash: values.ADMIN_PASSWORD_HASH,
    sessionSecret: values.SESSION_SECRET,
    smtp,
  };
}
