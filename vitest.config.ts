import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
