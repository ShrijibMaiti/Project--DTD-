/**
 * gps/tests/batcher.test.ts
 * Proofs verify; tampering is caught; missing pings are detectable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import {
  MerkleBatcher, buildTree, rootOf, proofFor, pingLeaf, type Batch, type BatchStore,
} from "../batching/merkle-batcher";
import { SignerTier, type SignedPing } from "../signing/gateway-signer";

const TRIP = keccak256(toHex("trip-batcher-001"));

function makePing(overrides: Partial<SignedPing> = {}): SignedPing {
  return {
    deviceId: "DEV-001",
    truckId: "truck-1",
    tripId: TRIP,
    lat: 28.6139,
    lng: 77.209,
    ts: 1_760_000_000,
    speedKph: 45,
    receivedAt: 1_760_000_005,
    signerTier: SignerTier.GATEWAY_VERIFIED_DEVICE,
    signerAddress: "0x1111111111111111111111111111111111111111",
    gatewaySig: ("0x" + "ab".repeat(65)) as Hex,
    ...overrides,
  };
}

function route(n: number, startTs = 1_760_000_000, stepS = 30): SignedPing[] {
  return Array.from({ length: n }, (_, i) =>
    makePing({
      ts: startTs + i * stepS,
      lat: 28.6139 - i * 0.01,
      lng: 77.209 - i * 0.012,
    })
  );
}

class InMemoryBatchStore implements BatchStore {
  pending = new Map<string, SignedPing[]>();
  batches: Array<Batch & { batchIndex: number | null }> = [];

  async drain(tripId: string, upToTs: number) {
    const all = this.pending.get(tripId) ?? [];
    return all.filter((p) => p.ts <= upToTs);
  }
  async saveBatch(b: Batch & { batchIndex: number | null }) {
    this.batches.push(b);
  }
  async markAnchored(tripId: string, batchIndex: number) {
    const b = this.batches.find((x) => x.tripId === tripId && x.batchIndex === null);
    if (b) b.batchIndex = batchIndex;
  }
  async lastBatchToTs(tripId: string) {
    const mine = this.batches.filter((b) => b.tripId === tripId);
    return mine.length ? Math.max(...mine.map((b) => b.toTs)) : null;
  }
  async tripsWithPending() {
    return [...this.pending.keys()];
  }
}

describe("Merkle leaves + proofs", () => {
  it("every honest ping verifies against the root", () => {
    const pings = route(8);
    const tree = buildTree(pings);
    const root = rootOf(tree);

    for (const p of pings) {
      const proof = proofFor(tree, p);
      expect(tree.verify(
        proof.map((h) => Buffer.from(h.slice(2), "hex")),
        Buffer.from(pingLeaf(p).slice(2), "hex"),
        Buffer.from(root.slice(2), "hex")
      )).toBe(true);
    }
  });

  it("TAMPER: editing a coordinate by 11cm breaks the leaf", () => {
    const p = makePing();
    const original = pingLeaf(p);
    const edited = pingLeaf({ ...p, lat: p.lat + 0.000001 });
    expect(edited).not.toBe(original);
  });

  it("TAMPER: swapping the signature breaks the leaf", () => {
    const p = makePing();
    const forged = pingLeaf({ ...p, gatewaySig: ("0x" + "cd".repeat(65)) as Hex });
    expect(forged).not.toBe(pingLeaf(p));
  });

  it("TAMPER: changing the signer tier breaks the leaf", () => {
    // A Tier-1 record must not be presentable as Tier-3 proof.
    const p = makePing({ signerTier: SignerTier.GATEWAY });
    const upgraded = pingLeaf({ ...p, signerTier: SignerTier.DEVICE_SECURE_ELEMENT });
    expect(upgraded).not.toBe(pingLeaf(p));
  });

  it("a tampered ping does not verify with the honest proof", () => {
    const pings = route(8);
    const tree = buildTree(pings);
    const root = rootOf(tree);
    const proof = proofFor(tree, pings[3]);

    const tampered = { ...pings[3], lat: pings[3].lat + 0.01 };
    expect(tree.verify(
      proof.map((h) => Buffer.from(h.slice(2), "hex")),
      Buffer.from(pingLeaf(tampered).slice(2), "hex"),
      Buffer.from(root.slice(2), "hex")
    )).toBe(false);
  });

  it("different batches produce different roots", () => {
    expect(rootOf(buildTree(route(8)))).not.toBe(
      rootOf(buildTree(route(8, 1_760_100_000)))
    );
  });

  it("leaf construction is deterministic across rebuilds", () => {
    const pings = route(8);
    expect(rootOf(buildTree(pings))).toBe(rootOf(buildTree([...pings])));
  });
});

describe("MerkleBatcher", () => {
  let store: InMemoryBatchStore;
  let batcher: MerkleBatcher;

  beforeEach(() => {
    store = new InMemoryBatchStore();
    batcher = new MerkleBatcher(store);
  });

  it("closes a window into one batch", async () => {
    store.pending.set(TRIP, route(120));
    const batch = await batcher.closeWindow(TRIP, 1_760_099_999);

    expect(batch).not.toBeNull();
    expect(batch!.pingCount).toBe(120);
    expect(batch!.fromTs).toBeLessThan(batch!.toTs);
  });

  it("returns null for an idle truck — zero gas for zero movement", async () => {
    store.pending.set(TRIP, []);
    expect(await batcher.closeWindow(TRIP, 1_760_099_999)).toBeNull();
  });

  it("ENFORCES time ordering: a second batch never overlaps the first", async () => {
    store.pending.set(TRIP, route(60));
    const first = await batcher.closeWindow(TRIP, 1_760_001_800);
    expect(first).not.toBeNull();

    // Same pings offered again — all predate the last batch.
    const second = await batcher.closeWindow(TRIP, 1_760_001_800);
    expect(second).toBeNull(); // would have caused TimeOverlap on-chain
  });

  it("a later window anchors cleanly after an earlier one", async () => {
    store.pending.set(TRIP, route(30));
    const first = await batcher.closeWindow(TRIP, 1_760_000_900);
    expect(first).not.toBeNull();

    store.pending.set(TRIP, route(30, 1_760_003_600));
    const second = await batcher.closeWindow(TRIP, 1_760_005_000);
    expect(second).not.toBeNull();
    expect(second!.fromTs).toBeGreaterThan(first!.toTs);
  });

  it("sorts out-of-order arrivals before building the tree", async () => {
    const shuffled = [...route(10)].reverse();
    store.pending.set(TRIP, shuffled);
    const batch = await batcher.closeWindow(TRIP, 1_760_000_999);
    expect(batch!.fromTs).toBeLessThan(batch!.toTs);
  });

  it("closeAllDue sweeps every trip with pending telemetry", async () => {
    store.pending.set(TRIP, route(10));
    store.pending.set(keccak256(toHex("trip-2")), route(10));
    const batches = await batcher.closeAllDue(1_760_999_999);
    expect(batches).toHaveLength(2);
  });
});

describe("gap detection (missing pings are visible, not smoothed over)", () => {
  it("finds a 40-minute silence mid-route", () => {
    const before = route(20);
    const after = route(20, before[19].ts + 2400); // 40 min later
    const gaps = MerkleBatcher.detectGaps([...before, ...after]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapS).toBe(2400);
  });

  it("normal cadence produces no gaps", () => {
    expect(MerkleBatcher.detectGaps(route(50))).toHaveLength(0);
  });

  it("finds multiple gaps in one trip", () => {
    const a = route(10);
    const b = route(10, a[9].ts + 1800);
    const c = route(10, b[9].ts + 3600);
    expect(MerkleBatcher.detectGaps([...a, ...b, ...c])).toHaveLength(2);
  });
});