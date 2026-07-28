/**
 * custody/doublescan/lifecycle-index.ts
 * The append-only scan log. Every scanner writes here in exactly the
 * scan-event.schema shape. Nothing in this file ever updates or deletes —
 * a box's history is a timeline, and timelines don't get edited.
 *
 * This index is what makes "one box, two lives" detectable.
 */

import { randomUUID } from "crypto";
import {
  ScanContext,
  ScanEventSchema,
  type ScanEvent,
} from "@dtd/shared/scan-event.schema";

export interface LifecycleStore {
  /** Append-only. Must be idempotent on (pieceId, clientNonce). */
  append(e: ScanEvent): Promise<{ inserted: boolean }>;
  byPiece(pieceId: string): Promise<ScanEvent[]>;
  byManifest(manifestId: string, context?: ScanContext): Promise<ScanEvent[]>;
  distinctPieces(manifestId: string, context: ScanContext): Promise<string[]>;
}

export class LifecycleIndex {
  constructor(private store: LifecycleStore) {}

  /**
   * Record a scan. Returns the full history so callers (fork detector,
   * verify page) can reason about the piece's timeline immediately.
   */
  async record(input: {
    pieceId: string;
    manifestId: string | null;
    context: ScanContext;
    scannerId?: string | null;
    locationHint?: string | null;
    clientNonce?: string;
    scannedAt?: string;
  }): Promise<{ event: ScanEvent; history: ScanEvent[]; isNew: boolean }> {
    const event = ScanEventSchema.parse({
      version: 1,
      scanId: randomUUID(),
      pieceId: input.pieceId,
      manifestId: input.manifestId,
      context: input.context,
      scannerId: input.scannerId ?? null,
      locationHint: input.locationHint ?? null,
      scannedAt: input.scannedAt ?? new Date().toISOString(),
      clientNonce: input.clientNonce,
    });

    const { inserted } = await this.store.append(event);
    const history = await this.store.byPiece(input.pieceId);
    return { event, history, isNew: inserted };
  }

  async history(pieceId: string): Promise<ScanEvent[]> {
    return this.store.byPiece(pieceId);
  }

  async eventsForManifest(manifestId: string, context?: ScanContext) {
    return this.store.byManifest(manifestId, context);
  }

  async distinctPiecesScanned(manifestId: string, context: ScanContext) {
    return this.store.distinctPieces(manifestId, context);
  }

  /** Batch write for the scanner's offline queue flush. */
  async recordBatch(
    items: Array<Parameters<LifecycleIndex["record"]>[0]>
  ): Promise<{ accepted: number; duplicates: number }> {
    let accepted = 0;
    let duplicates = 0;
    for (const i of items) {
      const { isNew } = await this.record(i);
      isNew ? accepted++ : duplicates++;
    }
    return { accepted, duplicates };
  }
}