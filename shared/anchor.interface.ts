/**
 * The one interface every hash in DTD takes to reach the chain.
 * Implemented by chain/sdk/anchor.ts. Swap Polygon for Base without
 * touching a single feature module.
 */

export type Hex = `0x${string}`;

export enum AnchorKind {
  GPS_BATCH = "GPS_BATCH",
  DOCUMENT = "DOCUMENT",
  MANIFEST = "MANIFEST",
  ATTESTATION = "ATTESTATION",
}

export interface AnchorRequest {
  kind: AnchorKind;
  /** The 32-byte fingerprint being anchored. */
  hash: Hex;
  /** Trip this anchor belongs to, where applicable. */
  tripId?: Hex;
  /** Kind-specific payload (batch window, doc type, piece count…). */
  meta?: Record<string, unknown>;
}

export interface AnchorReceipt {
  kind: AnchorKind;
  hash: Hex;
  txHash: Hex;
  blockNumber?: bigint;
  anchoredAt: string;
}

export interface AnchorGateway {
  anchor(req: AnchorRequest): Promise<AnchorReceipt>;
  /** Idempotency check before spending gas. */
  isAnchored(kind: AnchorKind, hash: Hex): Promise<boolean>;
}