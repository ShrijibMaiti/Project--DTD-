/**
 * chain/scripts/roundtrip.ts
 * THE SEAM TEST: TypeScript-built Merkle tree ↔ Solidity-verified proofs,
 * against a LIVE contract on anvil.
 *
 *   1. Build 8 GPS pings, hash them with sdk/merkle.pingLeaf
 *   2. Build the tree with sdk/merkle.buildBatchTree (merkletreejs, sortPairs)
 *   3. Anchor the root on the deployed TripLogAnchor
 *   4. For EVERY ping: prove it locally AND on-chain — both must accept
 *   5. Tamper one ping by 0.000001° — both must reject
 *   6. Feed a junk proof — must reject
 *   7. Cross-batch replay — must reject
 *
 * Run:  npx tsx scripts/roundtrip.ts
 * Requires: anvil running + deployments/localhost.json (from deploy.ts)
 */

import fs from "fs";
import path from "path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toHex,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  pingLeaf,
  buildBatchTree,
  batchRoot,
  proofForPing,
  verifyLocally,
  type GpsPing,
} from "../sdk/merkle";

// ---------------------------------------------------------------- setup

const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const abi = parseAbi([
  "function anchorBatch(bytes32 tripId, bytes32 root, uint64 fromTs, uint64 toTs) returns (uint256)",
  "function verifyPing(bytes32 tripId, uint256 batchIndex, bytes32 leaf, bytes32[] proof) view returns (bool)",
]);

function loadDeployment(): { TripLogAnchor: Address } {
  const file = path.join(process.cwd(), "deployments", "localhost.json");
  if (!fs.existsSync(file)) {
    console.error(
      "✗ deployments/localhost.json not found.\n" +
        "  Run: npx hardhat run scripts/deploy.ts --network localhost"
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).contracts;
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}   <-- SEAM BROKEN`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const { TripLogAnchor } = loadDeployment();
  const account = privateKeyToAccount(ANVIL_KEY_0);

  const pub = createPublicClient({ chain: foundry, transport: http() });
  const wallet = createWalletClient({ account, chain: foundry, transport: http() });

  console.log(`\n=== DTD Merkle round-trip ===`);
  console.log(`TripLogAnchor: ${TripLogAnchor}`);
  console.log(`anchorer     : ${account.address}\n`);

  // ---- 1. Build a realistic batch: Delhi -> Jaipur, 8 pings, 7.5 min apart
  const tripId = keccak256(toHex("roundtrip-trip-001"));
  const deviceId = keccak256(toHex("gps-device-WB12AB1234"));
  const t0 = 1_760_000_000;

  const route: Array<[number, number]> = [
    [28.6139, 77.209], [28.5355, 77.091], [28.4089, 76.9848], [28.1472, 76.6217],
    [27.8974, 76.3123], [27.5621, 76.1252], [27.1767, 75.9982], [26.9124, 75.7873],
  ];

  const pings: GpsPing[] = route.map(([lat, lng], i) => ({
    tripId,
    deviceId,
    lat,
    lng,
    ts: t0 + i * 450,
    // Phase-1 gateway signature placeholder — 65 opaque bytes.
    gatewaySig: ("0x" + "ab".repeat(65)) as Hex,
  }));

  // ---- 2 & 3. Tree in TypeScript, root onto the chain
  const tree = buildBatchTree(pings);
  const root = batchRoot(tree);
  console.log(`batch root   : ${root}`);

  const txHash = await wallet.writeContract({
    address: TripLogAnchor,
    abi,
    functionName: "anchorBatch",
    args: [tripId, root, BigInt(pings[0].ts), BigInt(pings[7].ts)],
  });
  await pub.waitForTransactionReceipt({ hash: txHash });
  console.log(`anchored     : ${txHash}\n`);

  // ---- 4. Every honest ping must verify — locally AND on-chain
  console.log(`[1/4] all 8 honest pings verify (TS + Solidity):`);
  for (let i = 0; i < pings.length; i++) {
    const proof = proofForPing(tree, pings[i]);
    const local = verifyLocally(root, pings[i], proof);
    const onchain = await pub.readContract({
      address: TripLogAnchor,
      abi,
      functionName: "verifyPing",
      args: [tripId, 0n, pingLeaf(pings[i]), proof],
    });
    check(`ping[${i}] local=${local} onchain=${onchain}`, local && onchain);
  }

  // ---- 5. Tampered ping (11cm of fraud) must fail everywhere
  console.log(`\n[2/4] tampered ping rejected:`);
  const tampered: GpsPing = { ...pings[3], lat: pings[3].lat + 0.000001 };
  const honestProof = proofForPing(tree, pings[3]);
  const tLocal = verifyLocally(root, tampered, honestProof);
  const tChain = await pub.readContract({
    address: TripLogAnchor,
    abi,
    functionName: "verifyPing",
    args: [tripId, 0n, pingLeaf(tampered), honestProof],
  });
  check(`edited coordinate: local=${tLocal} onchain=${tChain}`, !tLocal && !tChain);

  // ---- 6. Junk proof must fail
  console.log(`\n[3/4] junk proof rejected:`);
  const junkProof: Hex[] = [keccak256(toHex("not-a-sibling")), keccak256(toHex("nope"))];
  const jChain = await pub.readContract({
    address: TripLogAnchor,
    abi,
    functionName: "verifyPing",
    args: [tripId, 0n, pingLeaf(pings[0]), junkProof],
  });
  check(`junk proof: onchain=${jChain}`, !jChain);

  // ---- 7. Cross-batch replay must fail
  console.log(`\n[4/4] cross-batch replay rejected:`);
  const otherPings: GpsPing[] = pings.map((p) => ({ ...p, ts: p.ts + 3600 }));
  const otherTree = buildBatchTree(otherPings);
  const tx2 = await wallet.writeContract({
    address: TripLogAnchor,
    abi,
    functionName: "anchorBatch",
    args: [
      tripId,
      batchRoot(otherTree),
      BigInt(otherPings[0].ts),
      BigInt(otherPings[7].ts),
    ],
  });
  await pub.waitForTransactionReceipt({ hash: tx2 });

  const xChain = await pub.readContract({
    address: TripLogAnchor,
    abi,
    functionName: "verifyPing",
    args: [tripId, 1n, pingLeaf(pings[0]), proofForPing(tree, pings[0])], // batch-0 proof vs batch-1 root
  });
  check(`batch-0 proof against batch-1: onchain=${xChain}`, !xChain);

  // ---------------------------------------------------------------- verdict
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error(
      `SEAM BROKEN: sdk/merkle.ts and TripLogAnchor.sol disagree. ` +
        `Check leaf serialization (pingLeaf encodePacked order) and sortPairs.`
    );
    process.exit(1);
  }
  console.log(`SEAM LOCKED: TypeScript trees and Solidity verification agree byte-for-byte.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});