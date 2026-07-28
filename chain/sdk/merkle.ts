/**
 * chain/sdk/merkle.ts
 * Merkle tree construction + selective-disclosure proofs for GPS batches.
 * MUST stay byte-compatible with TripLogAnchor.verifyPing():
 *   - leaves: keccak256 of canonical serialized ping
 *   - tree: sorted pairs, keccak256 (merkletreejs { sortPairs: true })
 */

import { MerkleTree } from "merkletreejs";
import { keccak256, encodePacked, type Hex } from "viem";

// ---------------------------------------------------------------- types

export interface GpsPing {
  tripId: Hex;        // bytes32
  deviceId: Hex;      // bytes32 (registered device)
  lat: number;        // decimal degrees
  lng: number;
  ts: number;         // unix seconds
  gatewaySig: Hex;    // Phase-1: gateway signature over the ping
}

// ---------------------------------------------------------------- canonical leaf

/**
 * Canonical serialization — the ONE encoding of a ping.
 * Coordinates fixed to 6 decimal places (~11 cm precision) as integers,
 * because floats must never enter a hash.
 */
export function pingLeaf(p: GpsPing): Hex {
  const latE6 = BigInt(Math.round(p.lat * 1e6));
  const lngE6 = BigInt(Math.round(p.lng * 1e6));
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "int64", "int64", "uint64", "bytes"],
      [p.tripId, p.deviceId, latE6, lngE6, BigInt(p.ts), p.gatewaySig]
    )
  );
}

// ---------------------------------------------------------------- tree ops

const hashFn = (data: Buffer): Buffer =>
  Buffer.from(keccak256(("0x" + data.toString("hex")) as Hex).slice(2), "hex");

export function buildBatchTree(pings: GpsPing[]): MerkleTree {
  const leaves = pings.map((p) => Buffer.from(pingLeaf(p).slice(2), "hex"));
  return new MerkleTree(leaves, hashFn, { sortPairs: true });
}

export function batchRoot(tree: MerkleTree): Hex {
  return ("0x" + tree.getRoot().toString("hex")) as Hex;
}

/** Proof for ONE ping — reveal one moment, keep the rest of the route private. */
export function proofForPing(tree: MerkleTree, ping: GpsPing): Hex[] {
  const leaf = Buffer.from(pingLeaf(ping).slice(2), "hex");
  return tree.getProof(leaf).map((p) => ("0x" + p.data.toString("hex")) as Hex);
}

/** Local verification (same math the contract runs). */
export function verifyLocally(root: Hex, ping: GpsPing, proof: Hex[]): boolean {
  let computed = pingLeaf(ping);
  for (const p of proof) {
    computed =
      computed.toLowerCase() <= p.toLowerCase()
        ? keccak256(encodePacked(["bytes32", "bytes32"], [computed, p]))
        : keccak256(encodePacked(["bytes32", "bytes32"], [p, computed]));
  }
  return computed.toLowerCase() === root.toLowerCase();
}