import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@dtd/shared": path.resolve(__dirname, "../shared"),
      "@dtd/chain-sdk": path.resolve(__dirname, "../chain/sdk"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});