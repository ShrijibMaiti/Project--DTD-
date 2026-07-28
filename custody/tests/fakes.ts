/**
 * custody/tests/fakes.ts
 * In-memory doubles. No DB, no chain, no network.
 */

import { randomUUID } from "crypto";
import { keccak256, toBytes } from "viem";
import {
  canonicalManifest,
  CustodyStatus,
  type Manifest,
} from "@dtd/shared/manifest.schema";
import { ScanContext, type ScanEvent } from "@dtd/shared/scan-event.schema";
import type { LifecycleStore } from "../doublescan/lifecycle-index";
import type { ManifestStore } from "../manifest/builder";
import type { CustodyRecord } from "../manifest/handoff";
import { generatePieceIds } from "../qr/generator";

export function makeManifest(pieceCount: number, bookingTag = "booking"): Manifest {
  const pieces = generatePieceIds(pieceCount).map((pieceId) => ({ pieceId }));
  const draft = {
    version: 1 as const,
    tripId: keccak256(toBytes(`${bookingTag}-trip`)),
    bookingId: randomUUID(),
    transporterId: randomUUID(),
    pieceCount,
    pieces,
    loader: "0x1111111111111111111111111111111111111111",
    driver: "0x2222222222222222222222222222222222222222",
    receiver: "0x3333333333333333333333333333333333333333",
    createdAt: new Date().toISOString(),
  };
  return { ...draft, manifestId: keccak256(toBytes(canonicalManifest(draft))) };
}

export class InMemoryManifestStore implements ManifestStore {
  private byId = new Map<string, Manifest>();
  private byBooking = new Map<string, string>();
  private pieceIndex = new Map<string, string>();

  async put(m: Manifest & { chainTx: string }) {
    this.byId.set(m.manifestId, m);
    this.byBooking.set(m.bookingId, m.manifestId);
  }
  async get(id: string) { return this.byId.get(id) ?? null; }
  async getByBooking(bookingId: string) {
    const id = this.byBooking.get(bookingId);
    return id ? this.byId.get(id) ?? null : null;
  }
  async indexPieces(manifestId: string, pieceIds: string[]) {
    pieceIds.forEach((p) => this.pieceIndex.set(p, manifestId));
  }
  async findManifestByPiece(pieceId: string) {
    return this.pieceIndex.get(pieceId) ?? null;
  }
}

export class InMemoryLifecycleStore implements LifecycleStore {
  private events: ScanEvent[] = [];
  private nonces = new Set<string>();

  async append(e: ScanEvent) {
    if (e.clientNonce) {
      const key = `${e.pieceId}:${e.clientNonce}`;
      if (this.nonces.has(key)) return { inserted: false };
      this.nonces.add(key);
    }
    this.events.push(e);
    return { inserted: true };
  }
  async byPiece(pieceId: string) {
    return this.events.filter((e) => e.pieceId === pieceId);
  }
  async byManifest(manifestId: string, context?: ScanContext) {
    return this.events.filter(
      (e) => e.manifestId === manifestId && (!context || e.context === context)
    );
  }
  async distinctPieces(manifestId: string, context: ScanContext) {
    return [
      ...new Set(
        this.events
          .filter((e) => e.manifestId === manifestId && e.context === context)
          .map((e) => e.pieceId)
      ),
    ];
  }
}

/** Stands in for HandoffService without touching the chain. */
export class FakeHandoff {
  private records = new Map<string, CustodyRecord>();

  setStatus(
    manifestId: string,
    status: CustodyStatus,
    pieceCount: number,
    deliveredCount: number,
    deliveredAt: number | null = Math.floor(Date.now() / 1000)
  ) {
    this.records.set(manifestId, {
      manifestId,
      status,
      window:
        status === CustodyStatus.InCustody ? "TRANSIT"
        : status === CustodyStatus.Disputed ? "DISPUTED"
        : status === CustodyStatus.Short ? "UNLOADING" : "CLOSED",
      pieceCount,
      deliveredCount,
      custodyStartAt: Math.floor(Date.now() / 1000) - 86400,
      deliveredAt:
        status === CustodyStatus.Delivered || status === CustodyStatus.Short
          ? deliveredAt
          : null,
      loaderSigned: true,
      driverSigned: true,
      receiverSigned:
        status === CustodyStatus.Delivered || status === CustodyStatus.Short,
    });
  }

  async sync(manifestId: string): Promise<CustodyRecord> {
    return (
      this.records.get(manifestId) ?? {
        manifestId, status: CustodyStatus.None, window: "CLOSED",
        pieceCount: 0, deliveredCount: 0, custodyStartAt: null, deliveredAt: null,
        loaderSigned: false, driverSigned: false, receiverSigned: false,
      }
    );
  }

  async attributeLoss(manifestId: string) {
    const r = await this.sync(manifestId);
    const lost = r.pieceCount - r.deliveredCount;
    return {
      lost,
      window: "TRANSIT" as const,
      liableRole:
        r.loaderSigned && r.driverSigned && r.receiverSigned
          ? ("DRIVER" as const)
          : ("UNDETERMINED" as const),
      narrative:
        `${lost} of ${r.pieceCount} pieces unaccounted for. Loss occurred ` +
        `inside the driver's custody window.`,
    };
  }

  async assertScannable(manifestId: string) {
    const r = await this.sync(manifestId);
    if (r.status !== CustodyStatus.InCustody) throw new Error("NOT_IN_TRANSIT");
    return r;
  }
}

export class AllowAllLimiter {
  async allow() { return true; }
}