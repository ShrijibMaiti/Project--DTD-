/**
 * custody/reconcile/counter.ts
 * Live reconciliation: scanned set vs manifest set.
 * Produces the same-day answer — 175/200, and WHICH 25 are missing.
 */

import type { Manifest } from "@dtd/shared/manifest.schema";
import { ScanContext, type ScanEvent } from "@dtd/shared/scan-event.schema";
import type { ManifestStore } from "../manifest/builder";
import type { LifecycleIndex } from "../doublescan/lifecycle-index";

export interface ReconcileResult {
  manifestId: string;
  expected: number;
  scanned: number;
  missing: number;
  extra: number;
  complete: boolean;
  missingPieceIds: string[];
  /** Scanned at unloading but absent from the manifest — possible clones. */
  offManifestPieceIds: string[];
  duplicateScans: number;
}

export class ReconcileCounter {
  constructor(
    private manifests: ManifestStore,
    private lifecycle: LifecycleIndex
  ) {}

  async reconcile(manifestId: string): Promise<ReconcileResult> {
    const manifest = await this.manifests.get(manifestId);
    if (!manifest) throw new Error("MANIFEST_NOT_FOUND");

    const events = await this.lifecycle.eventsForManifest(
      manifestId,
      ScanContext.UNLOADING
    );

    const expectedIds = new Set(manifest.pieces.map((p) => p.pieceId));
    const scannedIds = new Set<string>();
    let duplicateScans = 0;

    for (const e of events) {
      if (scannedIds.has(e.pieceId)) duplicateScans++;
      else scannedIds.add(e.pieceId);
    }

    const missingPieceIds = [...expectedIds].filter((id) => !scannedIds.has(id));
    const offManifestPieceIds = [...scannedIds].filter((id) => !expectedIds.has(id));
    const validScanned = scannedIds.size - offManifestPieceIds.length;

    return {
      manifestId,
      expected: manifest.pieceCount,
      scanned: validScanned,
      missing: missingPieceIds.length,
      extra: offManifestPieceIds.length,
      complete: missingPieceIds.length === 0 && offManifestPieceIds.length === 0,
      missingPieceIds,
      offManifestPieceIds,
      duplicateScans,
    };
  }

  /** Cheap progress read for the scanner UI (no missing-list computation). */
  async progress(manifestId: string): Promise<{ scanned: number; expected: number }> {
    const manifest = await this.manifests.get(manifestId);
    if (!manifest) throw new Error("MANIFEST_NOT_FOUND");
    const ids = await this.lifecycle.distinctPiecesScanned(
      manifestId,
      ScanContext.UNLOADING
    );
    return { scanned: ids.length, expected: manifest.pieceCount };
  }

  /** One-line summary for WhatsApp/ops. */
  static summarize(r: ReconcileResult): string {
    if (r.complete) return `✅ ${r.scanned}/${r.expected} — complete.`;
    const parts = [`⚠ ${r.scanned}/${r.expected} scanned`];
    if (r.missing) parts.push(`${r.missing} MISSING`);
    if (r.extra) parts.push(`${r.extra} off-manifest`);
    return parts.join(" · ");
  }
}