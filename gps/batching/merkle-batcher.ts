/**
 * gps/batching/merkle-batcher.ts
 * ~120 signed pings/hour → one Merkle root → TripLogAnchor.
 *
 * Anchoring every ping would cost ~120× more gas for zero extra proof value.
 * One root per hour proves every ping in that hour, and selective disclosure
 * lets an insurer verify a single moment without seeing the whole route.
 *
 * MUST stay byte-compatible with chain/sdk/merkle.ts and
 * TripLogAnchor.verifyPing(): keccak256 leaves, sorted-pair tree.
 */

import { MerkleTree } from "merkletreejs";
import { keccak256, encodePacked, type Hex } from "viem";
import type { SignedPing } from "../signing/gateway-signer";

export interface Batch {
  tripId: Hex;
  root: Hex;
  fromTs: number;
  toTs: number;
  pingCount: number;
  pings: SignedPing[];
}

export interface BatchStore {
  /** Pending pings for a trip, ordered by ts. */
  drain(tripId: string, upToTs: number): Promise<SignedPing[]>;
  saveBatch(b: Batch & { batchIndex: number | null }): Promise<void>;
  markAnchored(tripId: string, batchIndex: number, txHash: string): Promise<void>;
  lastBatchToTs(tripId: string): Promise<number | null>;
  tripsWithPending(): Promise<string[]>;
}

export const BATCH_WINDOW_S = 3600; // one hour

/**
 * Canonical leaf. Field order is FROZEN — changing it invalidates every
 * previously anchored batch.
 */
export function pingLeaf(p: SignedPing): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "int64", "int64", "uint64", "uint8", "bytes"],
      [
        p.tripId as Hex,
        keccak256(encodePacked(["string"], [p.deviceId])),
        BigInt(Math.round(p.lat * 1e6)),
        BigInt(Math.round(p.lng * 1e6)),
        BigInt(p.ts),
        p.signerTier,
        p.gatewaySig,
      ]
    )
  );
}

const hashFn = (data: Buffer): Buffer =>
  Buffer.from(keccak256(("0x" + data.toString("hex")) as Hex).slice(2), "hex");

export function buildTree(pings: SignedPing[]): MerkleTree {
  const leaves = pings.map((p) => Buffer.from(pingLeaf(p).slice(2), "hex"));
  return new MerkleTree(leaves, hashFn, { sortPairs: true });
}

export function rootOf(tree: MerkleTree): Hex {
  return ("0x" + tree.getRoot().toString("hex")) as Hex;
}

export function proofFor(tree: MerkleTree, ping: SignedPing): Hex[] {
  const leaf = Buffer.from(pingLeaf(ping).slice(2), "hex");
  return tree.getProof(leaf).map((p) => ("0x" + p.data.toString("hex")) as Hex);
}

export class MerkleBatcher {
  constructor(private store: BatchStore) {}

  /**
   * Close a batch window for one trip. Returns null when there is nothing to
   * anchor — an idle truck should cost zero gas.
   *
   * Time-ordering is enforced here because TripLogAnchor rejects overlapping
   * windows: fromTs MUST be strictly after the previous batch's toTs.
   */
  async closeWindow(tripId: string, upToTs: number): Promise<Batch | null> {
    const pings = await this.store.drain(tripId, upToTs);
    if (pings.length === 0) return null;

    const sorted = [...pings].sort((a, b) => a.ts - b.ts);
    const lastToTs = await this.store.lastBatchToTs(tripId);

    const usable = lastToTs === null
      ? sorted
      : sorted.filter((p) => p.ts > lastToTs);

    if (usable.length === 0) return null; // all pings predate the last batch

    const tree = buildTree(usable);
    const batch: Batch = {
      tripId: usable[0].tripId as Hex,
      root: rootOf(tree),
      fromTs: usable[0].ts,
      toTs: usable[usable.length - 1].ts,
      pingCount: usable.length,
      pings: usable,
    };

    await this.store.saveBatch({ ...batch, batchIndex: null });
    return batch;
  }

  /** Sweep every trip with pending telemetry. Called hourly by the worker. */
  async closeAllDue(now = Math.floor(Date.now() / 1000)): Promise<Batch[]> {
    const trips = await this.store.tripsWithPending();
    const out: Batch[] = [];
    for (const tripId of trips) {
      const b = await this.closeWindow(tripId, now);
      if (b) out.push(b);
    }
    return out;
  }

  /**
   * Gap detection. Regular telemetry has a known cadence; a hole in it is
   * either device failure or something worth asking about. Either way the
   * evidence packet should say so rather than present a route with a silent
   * 40-minute void as if it were continuous.
   */
  static detectGaps(
    pings: SignedPing[],
    expectedIntervalS = 30,
    toleranceFactor = 4
  ): Array<{ fromTs: number; toTs: number; gapS: number }> {
    const sorted = [...pings].sort((a, b) => a.ts - b.ts);
    const threshold = expectedIntervalS * toleranceFactor;
    const gaps: Array<{ fromTs: number; toTs: number; gapS: number }> = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].ts - sorted[i - 1].ts;
      if (gap > threshold) {
        gaps.push({ fromTs: sorted[i - 1].ts, toTs: sorted[i].ts, gapS: gap });
      }
    }
    return gaps;
  }
}