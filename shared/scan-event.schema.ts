/**
 * The immutable lifecycle event the double-scan net depends on.
 * EVERY scanner emits exactly this shape: godown PWA, public verify page,
 * and any future partner integration. One shape = the net grows with zero rework.
 */

import { z } from "zod";

export enum ScanContext {
  /** Loading dock, before custody starts. */
  LOADING = "LOADING",
  /** Godown scan-in at delivery. */
  UNLOADING = "UNLOADING",
  /** Anyone, anywhere, after custody closed — the surveillance net. */
  PUBLIC_VERIFY = "PUBLIC_VERIFY",
  /** Authenticated partner (retailer, brand auditor). */
  PARTNER = "PARTNER",
}

export const ScanEventSchema = z.object({
  version: z.literal(1),
  scanId: z.string().uuid(),
  pieceId: z.string().regex(/^DTD-[0-9A-HJ-NP-Z]{10}$/),
  manifestId: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  context: z.nativeEnum(ScanContext),

  /** Who scanned. Null for anonymous public scans. */
  scannerId: z.string().nullable(),
  /** Coarse location only (city-level) — DPDP: never precise for public scans. */
  locationHint: z.string().max(120).nullable(),

  scannedAt: z.string().datetime(),
  /** Client-supplied nonce for idempotency across flaky godown wifi. */
  clientNonce: z.string().max(64).optional(),
});

export type ScanEvent = z.infer<typeof ScanEventSchema>;

/** What the fork detector concludes. */
export enum ForkVerdict {
  CLEAN = "CLEAN",
  /** Same piece scanned in two custody chains — clone exists. */
  DUPLICATE_LIFE = "DUPLICATE_LIFE",
  /** Scanned alive after its custody chain closed. */
  POST_CLOSURE_SIGHTING = "POST_CLOSURE_SIGHTING",
  /** Piece ID doesn't exist in any manifest — fabricated QR. */
  UNKNOWN_PIECE = "UNKNOWN_PIECE",
  /** Scanned at unloading but not on this manifest. */
  NOT_ON_MANIFEST = "NOT_ON_MANIFEST",
}