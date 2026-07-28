import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

/**
 * Hybrid repo: Foundry owns testing (test/*.t.sol, out/, cache/);
 * Hardhat owns deployment (scripts/deploy.ts, artifacts/, cache_hardhat/).
 * Both compile from contracts/ with the same pinned solc.
 */

// Anvil's default account #0 — safe fallback for LOCAL ONLY.
const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const DEPLOYER_KEY = process.env.DTD_DEPLOYER_KEY ?? ANVIL_KEY_0;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24", // matches foundry.toml — one compiler, reproducible builds
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "contracts",
    scripts: "scripts",
    tests: "hh-test",        // unused; keeps hardhat away from Foundry's test/
    cache: "cache_hardhat",  // MUST differ from Foundry's cache/
    artifacts: "artifacts",
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337, // anvil default
      accounts: [ANVIL_KEY_0],
    },
    amoy: {
      url: process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: process.env.DTD_DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
      chainId: 137,
      accounts: process.env.DTD_DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
  mocha: { timeout: 120_000 },
};

export default config;