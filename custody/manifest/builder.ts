/**
 * custody/manifest/builder.ts
 * Trip → itemized manifest (N piece IDs) → canonical hash → on-chain.
 *
 * The manifestId IS the keccak256 of the canonical manifest, which means
 * the ID cannot be minted without fixing every piece in it. Add or remove
 * one box and you get a different manifest entirely — no silent edits.
 */

import { randomUUID } from "crypto";
import { keccak256, toBytes, type Hex, type Address } from "viem";
import {
  ManifestSchema,
  canonicalManifest,
  type Manifest,
  type Piece,
} from "@dtd/shared/manifest.schema";
import { createManifest as anchorCreateManifest } from "@dtd/chain-sdk/anchor";
import { generatePieceIds } from "../qr/generator";

export interface ManifestStore {
  put(m: Manifest & { chainTx: string }): Promise<void>;
  get(manifestId: string): Promise<Manifest | null>;
  getByBooking(bookingId: string): Promise<Manifest | null>;
  /** Index every pieceId → manifestId for O(1) fork-detector lookups. */
  indexPieces(manifestId: string, pieceIds: string[]): Promise<void>;
  findManifestByPiece(pieceId: string): Promise<string | null>;
}

export interface BuildManifestInput {
  bookingId: string;
  transporterId: string;
  tripId: Hex;
  /** Either supply explicit pieces, or a count to auto-generate IDs. */
  pieces?: Array<Omit<Piece, "pieceId"> & { pieceId?: string }>;
  pieceCount?: number;
  loader: Address;
  driver: Address;
  receiver: Address;
}

export class ManifestBuilder {
  constructor(private store: ManifestStore) {}

  /**
   * Build → validate → hash → anchor → persist.
   * Anchoring happens BEFORE persistence: if the chain write fails we have
   * no half-real manifest sitting in the database claiming to be authoritative.
   */
  async build(input: BuildManifestInput): Promise<Manifest & { chainTx: string }> {
    const existing = await this.store.getByBooking(input.bookingId);
    if (existing) {
      throw new Error(`MANIFEST_EXISTS_FOR_BOOKING:${input.bookingId}`);
    }

    const pieces = this.resolvePieces(input);
    if (pieces.length === 0) throw new Error("MANIFEST_NEEDS_AT_LEAST_ONE_PIECE");

    const draft = {
      version: 1 as const,
      tripId: input.tripId,
      bookingId: input.bookingId,
      transporterId: input.transporterId,
      pieceCount: pieces.length,
      pieces,
      loader: input.loader,
      driver: input.driver,
      receiver: input.receiver,
      createdAt: new Date().toISOString(),
    };

    // The ID is the hash of everything above it.
    const manifestId = keccak256(toBytes(canonicalManifest(draft))) as string;
    const manifest = ManifestSchema.parse({ ...draft, manifestId });

    const chainTx = await anchorCreateManifest(
      manifestId as Hex,
      input.tripId,
      manifest.pieceCount,
      input.loader,
      input.driver,
      input.receiver
    );

    const record = { ...manifest, chainTx };
    await this.store.put(record);
    await this.store.indexPieces(manifestId, pieces.map((p) => p.pieceId));

    return record;
  }

  /**
   * Recompute the hash from stored contents and compare to the stored ID.
   * If these ever diverge, the database was edited outside the pipeline.
   */
  async verifyIntegrity(manifestId: string): Promise<boolean> {
    const m = await this.store.get(manifestId);
    if (!m) return false;
    const { manifestId: _id, ...rest } = m;
    return keccak256(toBytes(canonicalManifest(rest))) === manifestId;
  }

  private resolvePieces(input: BuildManifestInput): Piece[] {
    if (input.pieces?.length) {
      const generated = generatePieceIds(
        input.pieces.filter((p) => !p.pieceId).length
      );
      let g = 0;
      return input.pieces.map((p) => ({
        pieceId: p.pieceId ?? generated[g++],
        sku: p.sku,
        weightKg: p.weightKg,
      }));
    }
    if (!input.pieceCount) throw new Error("NEED_PIECES_OR_PIECE_COUNT");
    return generatePieceIds(input.pieceCount).map((pieceId) => ({ pieceId }));
  }
}

/** Convenience for callers that only have the raw contents. */
export function computeManifestId(draft: Omit<Manifest, "manifestId">): Hex {
  return keccak256(toBytes(canonicalManifest(draft)));
}

export function newScanId(): string {
  return randomUUID();
}