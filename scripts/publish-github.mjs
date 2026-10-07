import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
// Trust only this checkout for child Git commands; do not change global settings.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: cwd,
};
function run(args, options = {}) {
  return spawnSync("gh", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    ...options,
  });
}
const auth = run(["api", "user", "--jq", ".login"]);
if (auth.status !== 0) {
  console.error("Authenticate first: gh auth login --hostname github.com");
  process.exit(1);
}
const owner = auth.stdout.trim();
const repo = `${owner}/site-watch`;
const check = run(["api", `repos/${repo}`]);
if (check.status === 0) {
  console.error(`${repo} already exists. Stopped without changing it.`);
  process.exit(1);
}
if (!check.stderr.includes("404")) {
  console.error(
    "Could not verify whether the repository exists. Check GitHub access before retrying.",
  );
  process.exit(1);
}
const status = spawnSync("git", ["status", "--porcelain"], {
  cwd,
  env: gitEnv,
  encoding: "utf8",
});
if (status.status !== 0 || status.stdout.trim()) {
  console.error(
    "Commit the reviewed project first. The working tree must be clean.",
  );
  process.exit(1);
}
const create = run(
  [
    "repo",
    "create",
    repo,
    "--public",
    "--source",
    ".",
    "--remote",
    "origin",
    "--push",
    "--description",
    "Self-hosted HTTP monitoring for multiple domains, with optional email alerts. English UI and English/Portuguese documentation.",
  ],
  { stdio: "inherit" },
);
if (create.status !== 0) process.exit(create.status ?? 1);
const verify = run([
  "repo",
  "view",
  repo,
  "--json",
  "url,visibility",
  "--jq",
  '.url + " (" + .visibility + ")"',
]);
process.stdout.write(verify.stdout);
process.exit(verify.status ?? 1);
