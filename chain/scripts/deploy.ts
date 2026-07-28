/**
 * chain/scripts/deploy.ts
 * Deploy all 5 Trust Engine contracts + wire roles + pin addresses.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network localhost
 *   npx hardhat run scripts/deploy.ts --network amoy
 *   npx hardhat run scripts/deploy.ts --network polygon
 *
 * Writes chain/deployments/<network>.json — the single source of truth
 * for sdk/anchor.ts env vars and scripts/roundtrip.ts. Never hand-edit.
 */

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n=== Project DTD deploy ===`);
  console.log(`network : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`deployer: ${deployer.address}`);
  console.log(
    `balance : ${ethers.formatEther(
      await ethers.provider.getBalance(deployer.address)
    )}\n`
  );

  const ARBITER = process.env.DTD_ARBITER_ADDR ?? deployer.address;
  const PLATFORM = process.env.DTD_PLATFORM_ADDR ?? deployer.address;
  const ANCHORER = process.env.DTD_ANCHORER_ADDR ?? deployer.address;

  if (network.name === "polygon" && !process.env.DTD_ARBITER_ADDR) {
    throw new Error(
      "MAINNET GUARD: refusing to deploy to polygon with a defaulted arbiter. " +
        "Set DTD_ARBITER_ADDR to the ops multisig (see keys/rotation.md)."
    );
  }

  // ---- 1. TripLogAnchor -------------------------------------------------
  const TripLogAnchor = await ethers.getContractFactory("TripLogAnchor");
  const tripLog = await TripLogAnchor.deploy();
  await tripLog.waitForDeployment();
  console.log(`TripLogAnchor    : ${await tripLog.getAddress()}`);

  // ---- 2. DocumentRegistry ---------------------------------------------
  const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
  const docReg = await DocumentRegistry.deploy();
  await docReg.waitForDeployment();
  console.log(`DocumentRegistry : ${await docReg.getAddress()}`);

  // ---- 3. CustodyManifest ----------------------------------------------
  const CustodyManifest = await ethers.getContractFactory("CustodyManifest");
  const custody = await CustodyManifest.deploy();
  await custody.waitForDeployment();
  console.log(`CustodyManifest  : ${await custody.getAddress()}`);

  // ---- 4. ReputationLedger ---------------------------------------------
  const ReputationLedger = await ethers.getContractFactory("ReputationLedger");
  const reputation = await ReputationLedger.deploy();
  await reputation.waitForDeployment();
  console.log(`ReputationLedger : ${await reputation.getAddress()}`);

  // ---- 5. Escrow (wired to CustodyManifest) ----------------------------
  const Escrow = await ethers.getContractFactory("Escrow");
  const escrow = await Escrow.deploy(await custody.getAddress(), ARBITER);
  await escrow.waitForDeployment();
  console.log(`Escrow           : ${await escrow.getAddress()}`);

  // ---- 6. Authorize backend services -----------------------------------
  console.log(`\nwiring roles...`);
  await (await tripLog.setAnchorer(ANCHORER, true)).wait();
  await (await docReg.setRegistrar(PLATFORM, true)).wait();
  await (await custody.setPlatform(PLATFORM, true)).wait();
  await (await reputation.setPlatform(PLATFORM, true)).wait();
  console.log(`anchorer  -> ${ANCHORER}`);
  console.log(`registrar -> ${PLATFORM}`);
  console.log(`platform  -> ${PLATFORM}`);

  // ---- 7. Pin addresses -------------------------------------------------
  const out = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    arbiter: ARBITER,
    contracts: {
      TripLogAnchor: await tripLog.getAddress(),
      DocumentRegistry: await docReg.getAddress(),
      CustodyManifest: await custody.getAddress(),
      ReputationLedger: await reputation.getAddress(),
      Escrow: await escrow.getAddress(),
    },
  };

  const dir = path.join(process.cwd(), "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\naddresses pinned -> ${file}`);

  if (network.name === "polygon") {
    console.log(
      `\n⚠ MAINNET: transfer ownership of all 5 contracts to the multisig NOW ` +
        `(see keys/rotation.md).`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});