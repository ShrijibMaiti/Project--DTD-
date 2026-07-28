/**
 * THE contract between the physical world and the chain.
 * Consumed by: cosign-links, PWA scanner, reconcile/release-gate,
 * Escrow.sol's release condition, and the fork detector.
 * If this is strict, a disputed delivery can never be ambiguous.
 */

import { z } from "zod";

export const PieceSchema = z.object({
  /** Globally unique piece ID; also the QR payload's `p` field. */
  pieceId: z.string().regex(/^DTD-[0-9A-HJ-NP-Z]{10}$/), // Crockford-ish, no I/L/O/U
  /** Optional SKU/description for the loading dock. */
  sku: z.string().max(64).optional(),
  weightKg: z.number().positive().optional(),
});
export type Piece = z.infer<typeof PieceSchema>;

export const ManifestSchema = z.object({
  version: z.literal(1),
  manifestId: z.string().regex(/^0x[0-9a-f]{64}$/), // keccak256 of canonical form
  tripId: z.string().regex(/^0x[0-9a-f]{64}$/),
  bookingId: z.string().uuid(),
  transporterId: z.string().uuid(),

  pieceCount: z.number().int().positive(),
  pieces: z.array(PieceSchema).min(1),

  /** Signing addresses (from Domain 2 signer-service). */
  loader: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  driver: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  receiver: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  createdAt: z.string().datetime(),
}).refine((m) => m.pieces.length === m.pieceCount, {
  message: "pieceCount must equal pieces.length",
}).refine((m) => new Set(m.pieces.map((p) => p.pieceId)).size === m.pieces.length, {
  message: "duplicate pieceId in manifest",
});

export type Manifest = z.infer<typeof ManifestSchema>;

/** Mirrors CustodyManifest.Status exactly — do not reorder. */
export enum CustodyStatus {
  None = 0,
  Created = 1,
  InCustody = 2,
  Delivered = 3,
  Short = 4,
  Disputed = 5,
}

/**
 * Canonical serialization for hashing. Field order and formatting are frozen:
 * any change here invalidates every previously anchored manifest.
 */
export function canonicalManifest(
  m: Omit<Manifest, "manifestId">
): string {
  return JSON.stringify({
    v: m.version,
    trip: m.tripId,
    booking: m.bookingId,
    transporter: m.transporterId,
    count: m.pieceCount,
    pieces: [...m.pieces].sort((a, b) => a.pieceId.localeCompare(b.pieceId)).map((p) => ({
      id: p.pieceId,
      sku: p.sku ?? null,
      kg: p.weightKg ?? null,
    })),
    loader: m.loader.toLowerCase(),
    driver: m.driver.toLowerCase(),
    receiver: m.receiver.toLowerCase(),
    at: m.createdAt,
  });
}