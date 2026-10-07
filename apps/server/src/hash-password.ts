import { hashPassword } from "./auth.js";
import { createInterface } from "node:readline";
const input = createInterface({
  input: process.stdin,
  output: process.stderr,
  terminal: false,
});
process.stderr.write(
  "Enter an admin password via stdin (at least 12 characters):\n",
);
for await (const password of input) {
  if (password.length < 12 || password.length > 256) {
    process.stderr.write("Use 12 to 256 characters.\n");
    process.exitCode = 1;
  } else process.stdout.write(`${await hashPassword(password)}\n`);
  input.close();
  break;
}
