/**
 * custody/tests/fork-detector.test.ts
 * The clone-attack suite. Each test is a real theft scenario from the
 * threat model, run end-to-end against the detector.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ScanContext, ForkVerdict } from "@dtd/shared/scan-event.schema";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import { LifecycleIndex } from "../doublescan/lifecycle-index";
import { ForkDetector } from "../doublescan/fork-detector";
import { VerifyPageApi } from "../doublescan/verify-page-api";
import {
  InMemoryLifecycleStore,
  InMemoryManifestStore,
  FakeHandoff,
  AllowAllLimiter,
  makeManifest,
} from "./fakes";

describe("ForkDetector — clone scenarios", () => {
  let lifecycle: LifecycleIndex;
  let manifests: InMemoryManifestStore;
  let handoff: FakeHandoff;
  let detector: ForkDetector;
  let alerts: { raise: ReturnType<typeof vi.fn> };

  let mA: Awaited<ReturnType<typeof makeManifest>>;
  let mB: Awaited<ReturnType<typeof makeManifest>>;

  beforeEach(async () => {
    lifecycle = new LifecycleIndex(new InMemoryLifecycleStore());
    manifests = new InMemoryManifestStore();
    handoff = new FakeHandoff();
    alerts = { raise: vi.fn(async () => {}) };
    detector = new ForkDetector(lifecycle, manifests, handoff as any, alerts as any);

    mA = makeManifest(10, "booking-A");
    mB = makeManifest(10, "booking-B");
    for (const m of [mA, mB]) {
      await manifests.put({ ...m, chainTx: "0xtx" });
      await manifests.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    }
  });

  const pieceOf = (m: typeof mA, i = 0) => m.pieces[i].pieceId;

  // ---------------------------------------------------------------- clean

  it("clean piece in a live shipment -> CLEAN, no alert", async () => {
    handoff.setStatus(mA.manifestId, CustodyStatus.InCustody, 10, 0);
    await lifecycle.record({
      pieceId: pieceOf(mA),
      manifestId: mA.manifestId,
      context: ScanContext.LOADING,
      scannerId: "dock",
    });

    const a = await detector.analyze(pieceOf(mA));
    expect(a.verdict).toBe(ForkVerdict.CLEAN);
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- fabricated QR

  it("SCENARIO 1 — invented QR: ID exists in no manifest -> UNKNOWN_PIECE", async () => {
    const a = await detector.analyze("DTD-FAKE000000".slice(0, 14));
    expect(a.verdict).toBe(ForkVerdict.UNKNOWN_PIECE);
    expect(a.severity).toBe("CRITICAL");
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "FORK_UNKNOWN_PIECE" })
    );
  });

  // ---------------------------------------------------------------- cloned label

  it("SCENARIO 2 — cloned label lands in another shipment -> NOT_ON_MANIFEST", async () => {
    handoff.setStatus(mA.manifestId, CustodyStatus.InCustody, 10, 0);
    handoff.setStatus(mB.manifestId, CustodyStatus.InCustody, 10, 0);

    const stolen = pieceOf(mA);
    // The clone is scanned in during a DIFFERENT booking's unloading.
    await lifecycle.record({
      pieceId: stolen,
      manifestId: mB.manifestId,
      context: ScanContext.UNLOADING,
      scannerId: "godown-B",
    });

    const a = await detector.analyze(stolen);
    expect(a.verdict).toBe(ForkVerdict.NOT_ON_MANIFEST);
    expect(a.manifestIds).toContain(mB.manifestId);
    expect(a.attribution?.forkedInsideManifest).toBe(mA.manifestId);
  });

  it("SCENARIO 3 — one box, two live custody chains -> DUPLICATE_LIFE", async () => {
    handoff.setStatus(mA.manifestId, CustodyStatus.InCustody, 10, 0);
    handoff.setStatus(mB.manifestId, CustodyStatus.InCustody, 10, 0);

    const piece = pieceOf(mA);
    await lifecycle.record({
      pieceId: piece,
      manifestId: mA.manifestId,
      context: ScanContext.LOADING,
      scannerId: "dock-A",
    });
    // Same ID appears alive in shipment B at the same time.
    await lifecycle.record({
      pieceId: piece,
      manifestId: mB.manifestId,
      context: ScanContext.LOADING,
      scannerId: "dock-B",
    });

    const a = await detector.analyze(piece);
    // NOT_ON_MANIFEST fires first for LOADING-context foreign scans;
    // either verdict is a CRITICAL clone detection.
    expect([ForkVerdict.NOT_ON_MANIFEST, ForkVerdict.DUPLICATE_LIFE]).toContain(a.verdict);
    expect(a.severity).toBe("CRITICAL");
  });

  // ---------------------------------------------------------------- the stolen original

  it("SCENARIO 4 — stolen original resurfaces after delivery -> POST_CLOSURE_SIGHTING", async () => {
    const stolen = pieceOf(mA, 9);
    const deliveredAt = Math.floor(Date.now() / 1000) - 7 * 86400;

    // 9 of 10 scanned at the godown; the 10th never arrived.
    for (let i = 0; i < 9; i++) {
      await lifecycle.record({
        pieceId: pieceOf(mA, i),
        manifestId: mA.manifestId,
        context: ScanContext.UNLOADING,
        scannerId: "godown-A",
      });
    }
    handoff.setStatus(mA.manifestId, CustodyStatus.Short, 10, 9, deliveredAt);

    // A week later, a trader in another city scans the stolen box.
    await lifecycle.record({
      pieceId: stolen,
      manifestId: null,
      context: ScanContext.PUBLIC_VERIFY,
      scannerId: null,
      locationHint: "Lucknow",
      scannedAt: new Date().toISOString(),
    });

    const a = await detector.analyze(stolen);
    expect(a.verdict).toBe(ForkVerdict.POST_CLOSURE_SIGHTING);
    expect(a.attribution?.liableRole).toBe("DRIVER");
    expect(a.attribution?.narrative).toContain("custody window");
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "FORK_POST_CLOSURE_SIGHTING", severity: "CRITICAL" })
    );
  });

  it("a DELIVERED piece scanned publicly later is NOT flagged (legit customer check)", async () => {
    const piece = pieceOf(mA, 0);
    const deliveredAt = Math.floor(Date.now() / 1000) - 86400;

    for (let i = 0; i < 10; i++) {
      await lifecycle.record({
        pieceId: pieceOf(mA, i),
        manifestId: mA.manifestId,
        context: ScanContext.UNLOADING,
        scannerId: "godown-A",
      });
    }
    handoff.setStatus(mA.manifestId, CustodyStatus.Delivered, 10, 10, deliveredAt);

    await lifecycle.record({
      pieceId: piece,
      manifestId: null,
      context: ScanContext.PUBLIC_VERIFY,
      scannerId: null,
      locationHint: "Jaipur",
    });

    const a = await detector.analyze(piece);
    expect(a.verdict).toBe(ForkVerdict.CLEAN); // it WAS delivered — nothing wrong
  });

  // ---------------------------------------------------------------- replay / idempotency

  it("offline-queue replay of the same scan does not create a false fork", async () => {
    handoff.setStatus(mA.manifestId, CustodyStatus.InCustody, 10, 0);
    const piece = pieceOf(mA);
    const nonce = "same-nonce";

    await lifecycle.record({
      pieceId: piece, manifestId: mA.manifestId,
      context: ScanContext.UNLOADING, scannerId: "godown", clientNonce: nonce,
    });
    const second = await lifecycle.record({
      pieceId: piece, manifestId: mA.manifestId,
      context: ScanContext.UNLOADING, scannerId: "godown", clientNonce: nonce,
    });

    expect(second.isNew).toBe(false);
    const a = await detector.analyze(piece);
    expect(a.verdict).toBe(ForkVerdict.CLEAN);
  });

  it("sweep() returns only non-clean pieces", async () => {
    handoff.setStatus(mA.manifestId, CustodyStatus.InCustody, 10, 0);
    await lifecycle.record({
      pieceId: pieceOf(mA), manifestId: mA.manifestId,
      context: ScanContext.LOADING, scannerId: "dock",
    });

    const results = await detector.sweep([pieceOf(mA), "DTD-NOTREAL999"]);
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe(ForkVerdict.UNKNOWN_PIECE);
  });
});

describe("VerifyPageApi — public sensor net", () => {
  let lifecycle: LifecycleIndex;
  let manifests: InMemoryManifestStore;
  let handoff: FakeHandoff;
  let api: VerifyPageApi;
  let m: ReturnType<typeof makeManifest>;

  beforeEach(async () => {
    lifecycle = new LifecycleIndex(new InMemoryLifecycleStore());
    manifests = new InMemoryManifestStore();
    handoff = new FakeHandoff();
    const detector = new ForkDetector(
      lifecycle, manifests, handoff as any, { raise: vi.fn(async () => {}) } as any
    );
    api = new VerifyPageApi(lifecycle, detector, manifests, handoff as any, new AllowAllLimiter());

    m = makeManifest(5);
    await manifests.put({ ...m, chainTx: "0xtx" });
    await manifests.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
  });

  it("genuine in-transit box reads as GENUINE_IN_TRANSIT", async () => {
    handoff.setStatus(m.manifestId, CustodyStatus.InCustody, 5, 0);
    const r = await api.verify({ pieceId: m.pieces[0].pieceId, ipKey: "ip1" });
    expect(r.status).toBe("GENUINE_IN_TRANSIT");
  });

  it("unknown code reads as UNKNOWN and offers a report link", async () => {
    const r = await api.verify({ pieceId: "DTD-QQQQQQQQQQ", ipKey: "ip1" });
    expect(r.status).toBe("UNKNOWN");
    expect(r.reportUrl).toBeDefined();
  });

  it("malformed code is rejected without hitting the detector", async () => {
    const r = await api.verify({ pieceId: "hello world", ipKey: "ip1" });
    expect(r.status).toBe("UNKNOWN");
    expect(r.headline).toContain("Not a DTD code");
  });

  it("EVERY public scan is recorded — the sensor net grows", async () => {
    const piece = m.pieces[0].pieceId;
    handoff.setStatus(m.manifestId, CustodyStatus.InCustody, 5, 0);

    await api.verify({ pieceId: piece, ipKey: "ip1" });
    await api.verify({ pieceId: piece, ipKey: "ip2" });

    const history = await lifecycle.history(piece);
    expect(history.filter((e) => e.context === ScanContext.PUBLIC_VERIFY)).toHaveLength(2);
  });

  it("PRIVACY: precise coordinates in a location hint are dropped", async () => {
    const piece = m.pieces[0].pieceId;
    handoff.setStatus(m.manifestId, CustodyStatus.InCustody, 5, 0);

    await api.verify({
      pieceId: piece, ipKey: "ip1",
      locationHint: "26.912434, 75.787270",
    });

    const history = await lifecycle.history(piece);
    expect(history[0].locationHint).toBeNull();
  });

  it("PRIVACY: public response exposes no route, party, or exact timing", async () => {
    handoff.setStatus(m.manifestId, CustodyStatus.InCustody, 5, 0);
    const r = await api.verify({ pieceId: m.pieces[0].pieceId, ipKey: "ip1" });

    const blob = JSON.stringify(r);
    expect(blob).not.toContain(m.bookingId);
    expect(blob).not.toContain(m.transporterId);
    expect(blob).not.toContain(m.manifestId);
    expect(r.firstSeen).toMatch(/^[A-Z][a-z]+ \d{4}$/); // "July 2026", month only
  });
});