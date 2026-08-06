import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
