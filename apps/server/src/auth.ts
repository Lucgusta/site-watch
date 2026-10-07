import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, hash) => (error ? reject(error) : resolve(hash)),
    ),
  );
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, salt, expected] = stored.split("$");
  if (
    algorithm !== "scrypt" ||
    !salt ||
    !expected ||
    !/^[a-f0-9]{128}$/.test(expected)
  )
    return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export function sessionHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}
export function newToken(): string {
  return randomBytes(32).toString("hex");
}
export function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
