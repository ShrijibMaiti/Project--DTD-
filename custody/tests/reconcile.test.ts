/**
 * custody/tests/reconcile.test.ts
 * The shortage-detection and money-gate suite.
 * In-memory fakes: no DB, no chain, no network — fast and deterministic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ScanContext } from "@dtd/shared/scan-event.schema";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import { LifecycleIndex } from "../doublescan/lifecycle-index";
import { ReconcileCounter } from "../reconcile/counter";
import {
  InMemoryLifecycleStore,
  InMemoryManifestStore,
  FakeHandoff,
  makeManifest,
} from "./fakes";

describe("ReconcileCounter", () => {
  let lifecycle: LifecycleIndex;
  let manifests: InMemoryManifestStore;
  let counter: ReconcileCounter;
  let manifestId: string;
  let pieceIds: string[];

  beforeEach(async () => {
    lifecycle = new LifecycleIndex(new InMemoryLifecycleStore());
    manifests = new InMemoryManifestStore();
    counter = new ReconcileCounter(manifests, lifecycle);

    const m = makeManifest(200);
    await manifests.put({ ...m, chainTx: "0xtx" });
    await manifests.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    manifestId = m.manifestId;
    pieceIds = m.pieces.map((p) => p.pieceId);
  });

  async function scan(ids: string[], mId = manifestId) {
    for (const pieceId of ids) {
      await lifecycle.record({
        pieceId,
        manifestId: mId,
        context: ScanContext.UNLOADING,
        scannerId: "godown-1",
      });
    }
  }

  it("reports complete when all 200 scan", async () => {
    await scan(pieceIds);
    const r = await counter.reconcile(manifestId);
    expect(r.scanned).toBe(200);
    expect(r.missing).toBe(0);
    expect(r.complete).toBe(true);
    expect(ReconcileCounter.summarize(r)).toContain("complete");
  });

  it("THE CORE CASE: 175 of 200 -> flags 25 missing, names them", async () => {
    await scan(pieceIds.slice(0, 175));
    const r = await counter.reconcile(manifestId);

    expect(r.scanned).toBe(175);
    expect(r.missing).toBe(25);
    expect(r.complete).toBe(false);
    expect(r.missingPieceIds).toHaveLength(25);
    expect(r.missingPieceIds).toEqual(expect.arrayContaining([pieceIds[199]]));
    expect(ReconcileCounter.summarize(r)).toContain("25 MISSING");
  });

  it("counts duplicate scans without inflating the total", async () => {
    await scan(pieceIds.slice(0, 10));
    await scan(pieceIds.slice(0, 3)); // rescanned boxes
    const r = await counter.reconcile(manifestId);

    expect(r.scanned).toBe(10);
    expect(r.duplicateScans).toBe(3);
  });

  it("flags off-manifest pieces (possible clones) separately from missing", async () => {
    await scan(pieceIds.slice(0, 199));
    await scan(["DTD-ZZZZZZZZZZ"]); // a box that isn't on this manifest
    const r = await counter.reconcile(manifestId);

    expect(r.missing).toBe(1);
    expect(r.extra).toBe(1);
    expect(r.offManifestPieceIds).toEqual(["DTD-ZZZZZZZZZZ"]);
    expect(r.complete).toBe(false); // extras block completion too
  });

  it("ignores loading-context scans when reconciling unloading", async () => {
    for (const pieceId of pieceIds.slice(0, 50)) {
      await lifecycle.record({
        pieceId,
        manifestId,
        context: ScanContext.LOADING,
        scannerId: "dock-1",
      });
    }
    const r = await counter.reconcile(manifestId);
    expect(r.scanned).toBe(0);
    expect(r.missing).toBe(200);
  });

  it("progress() gives a cheap live count for the scanner UI", async () => {
    await scan(pieceIds.slice(0, 42));
    const p = await counter.progress(manifestId);
    expect(p).toEqual({ scanned: 42, expected: 200 });
  });
});

describe("ReleaseGate (money seam)", () => {
  let lifecycle: LifecycleIndex;
  let manifests: InMemoryManifestStore;
  let counter: ReconcileCounter;
  let handoff: FakeHandoff;
  let manifestId: string;
  let pieceIds: string[];
  let alerts: { raise: ReturnType<typeof vi.fn> };

  // ReleaseGate is imported lazily so we can stub the chain SDK per-test.
  async function makeGate(chainReleasable: boolean) {
    vi.doMock("@dtd/chain-sdk/verify", () => ({
      isReleasable: vi.fn(async () => chainReleasable),
    }));
    vi.doMock("@dtd/chain-sdk/anchor", () => ({
      confirmDelivery: vi.fn(async () => "0xtx"),
      getDeliveryDigest: vi.fn(async () => "0x" + "11".repeat(32)),
    }));
    const { ReleaseGate } = await import("../reconcile/release-gate");
    return new ReleaseGate(
      counter,
      handoff as any,
      manifests,
      { signDigest: vi.fn(async () => "0xsig") } as any,
      alerts as any,
      "http://platform.test/webhook",
      "test-secret"
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    lifecycle = new LifecycleIndex(new InMemoryLifecycleStore());
    manifests = new InMemoryManifestStore();
    counter = new ReconcileCounter(manifests, lifecycle);
    handoff = new FakeHandoff();
    alerts = { raise: vi.fn(async () => {}) };

    const m = makeManifest(200);
    await manifests.put({ ...m, chainTx: "0xtx" });
    await manifests.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    manifestId = m.manifestId;
    pieceIds = m.pieces.map((p) => p.pieceId);
  });

  async function scanAll(n: number) {
    for (const pieceId of pieceIds.slice(0, n)) {
      await lifecycle.record({
        pieceId,
        manifestId,
        context: ScanContext.UNLOADING,
        scannerId: "godown-1",
      });
    }
  }

  it("releases on a full 200/200 match", async () => {
    await scanAll(200);
    handoff.setStatus(manifestId, CustodyStatus.Delivered, 200, 200);
    const gate = await makeGate(true);

    const d = await gate.evaluate(manifestId);
    expect(d.releasable).toBe(true);
    expect(d.reason).toBe("COMPLETE_SCAN_MATCH");
  });

  it("FREEZES money on 175/200 — the whole point", async () => {
    await scanAll(175);
    handoff.setStatus(manifestId, CustodyStatus.Short, 200, 175);
    const gate = await makeGate(false);

    const d = await gate.evaluate(manifestId);
    expect(d.releasable).toBe(false);
    expect(d.reason).toBe("SHORT_DELIVERY");
    expect(d.reconcile.missing).toBe(25);
  });

  it("refuses release while still in transit", async () => {
    await scanAll(200);
    handoff.setStatus(manifestId, CustodyStatus.InCustody, 200, 0);
    const gate = await makeGate(false);

    const d = await gate.evaluate(manifestId);
    expect(d.releasable).toBe(false);
    expect(d.reason).toBe("NOT_YET_CONFIRMED");
  });

  it("refuses release on a disputed manifest", async () => {
    await scanAll(200);
    handoff.setStatus(manifestId, CustodyStatus.Disputed, 200, 200);
    const gate = await makeGate(false);

    const d = await gate.evaluate(manifestId);
    expect(d.releasable).toBe(false);
    expect(d.reason).toBe("DISPUTED");
  });

  it("DEFENSE IN DEPTH: off-chain says OK but chain says no -> frozen + alerted", async () => {
    await scanAll(200);
    handoff.setStatus(manifestId, CustodyStatus.Delivered, 200, 200);
    const gate = await makeGate(false); // chain disagrees

    const d = await gate.evaluate(manifestId);
    expect(d.releasable).toBe(false);
    expect(d.reason).toBe("CHAIN_DISAGREES");
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RELEASE_GATE_DIVERGENCE", severity: "CRITICAL" })
    );
  });

  it("blocks payout and never calls the platform webhook when short", async () => {
    await scanAll(175);
    handoff.setStatus(manifestId, CustodyStatus.Short, 200, 175);
    const gate = await makeGate(false);
    const fetchSpy = vi.spyOn(global, "fetch");

    const r = await gate.requestPayout(manifestId);
    expect(r.released).toBe(false);
    expect(r.reason).toBe("SHORT_DELIVERY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signs the TRUE scanned count, not the expected one", async () => {
    await scanAll(175);
    handoff.setStatus(manifestId, CustodyStatus.Short, 200, 175);
    const gate = await makeGate(false);

    const { getDeliveryDigest } = await import("@dtd/chain-sdk/anchor");
    await gate.confirmAndSign({
      manifestId,
      receiverPhone: "+919000000000",
      otpToken: "otp",
    });

    expect(getDeliveryDigest).toHaveBeenCalledWith(manifestId, 175); // NOT 200
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "SHORT_DELIVERY", severity: "CRITICAL" })
    );
  });
});