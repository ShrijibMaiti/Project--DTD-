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
    env: {
      DATABASE_URL: "postgresql://dtd_app:dtd_app_pw@localhost:5433/dtd_test",
      ADMIN_DATABASE_URL: "postgresql://postgres:dtd@localhost:5433/dtd_test",
      DTD_PLATFORM_PRIVATE_KEY:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      DTD_RPC_URL: "http://127.0.0.1:8545",
      DTD_TRIPLOG_ADDR: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      DTD_DOCREG_ADDR: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      DTD_CUSTODY_ADDR: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      DTD_REPUTATION_ADDR: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
      DTD_ESCROW_ADDR: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    },
    fileParallel: false,   // these share one database
  },
});