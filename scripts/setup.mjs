import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");
try {
  await access(envPath);
  console.error(
    ".env already exists. Keep it, or rename it before creating new credentials.",
  );
  process.exit(1);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const generated = process.argv.includes("--generate");
let username = "admin";
let password;
if (generated) {
  password = randomBytes(24).toString("base64url");
} else {
  if (!process.stdin.isTTY) {
    console.error(
      "Use an interactive terminal, or `npm run setup -- --generate`.",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  username =
    (await rl.question("Administrator username [admin]: ")).trim() || "admin";
  rl.close();
  let hidden = false;
  const mutedOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const secretInput = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });
  process.stdout.write(
    "Administrator password (12–256 characters; input hidden): ",
  );
  hidden = true;
  password = await secretInput.question("");
  secretInput.close();
  process.stdout.write("\n");
}
if (username.length > 80 || !/^[a-zA-Z0-9_.-]+$/.test(username))
  throw new Error(
    "Use a username of 1–80 letters, digits, dots, dashes, or underscores.",
  );
if (password.length < 12 || password.length > 256)
  throw new Error("Use a password of 12–256 characters.");
const salt = randomBytes(16).toString("hex");
const derive = promisify(scrypt);
const key = await derive(password, salt, 64, {
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
});
const hash = `scrypt$${salt}$${key.toString("hex")}`;
const dbPassword = randomBytes(24).toString("hex");
const content = [
  "# Generated locally. Private: never commit this file.",
  "NODE_ENV=development",
  "APP_ORIGIN=http://localhost:3000",
  "HOST=0.0.0.0",
  "PORT=3000",
  "POSTGRES_USER=sitewatch",
  "POSTGRES_DB=sitewatch",
  `POSTGRES_PASSWORD=${dbPassword}`,
  "POSTGRES_PORT=55432",
  `DATABASE_URL=postgresql://sitewatch:${dbPassword}@localhost:55432/sitewatch`,
  `ADMIN_USERNAME=${username}`,
  `ADMIN_PASSWORD_HASH='${hash}'`,
  `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
  "SMTP_HOST=",
  "SMTP_PORT=587",
  "SMTP_SECURE=false",
  "SMTP_USER=",
  "SMTP_PASSWORD=",
  "SMTP_FROM=",
  "",
].join("\n");
if (generated) {
  await mkdir(resolve(root, ".runtime"), { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(root, ".runtime/initial-admin.txt"),
    `Username: ${username}\nPassword: ${password}\n\nPrivate local credentials. Delete this file after saving the password in your password manager.\n`,
    { flag: "wx", mode: 0o600 },
  );
}
await writeFile(envPath, content, { flag: "wx", mode: 0o600 });
console.log(
  "Created a private .env with a password hash and random database/session secrets.",
);
if (generated)
  console.log(
    "Read your administrator credentials in .runtime/initial-admin.txt (gitignored).",
  );
console.log("Next: docker compose up --build");
