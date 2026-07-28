/**
 * The trip attestation shape: {trip_hash, on_time, dispute, sigs}.
 *
 * Consumed by ReputationLedger.sol's attest(), the driver and shipper signing
 * flows, and the lender portal's reputation read. The digest below MUST stay
 * byte-identical to ReputationLedger.attestationDigest() — a mismatch means
 * signatures verify locally and revert on-chain.
 */

import { z } from "zod";

export const AttestationSchema = z.object({
  version: z.literal(1),
  tripId: z.string().regex(/^0x[0-9a-f]{64}$/),
  manifestId: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),

  /** Signing addresses from Domain 2's signer-service. */
  driver: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  shipper: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  /** The two claims. Both are facts derived from evidence, not opinions. */
  onTime: z.boolean(),
  disputeFree: z.boolean(),

  /** Evidence the claims were derived from — for audit, never on-chain. */
  evidence: z.object({
    scheduledArrivalTs: z.number().int().nullable(),
    actualArrivalTs: z.number().int().nullable(),
    manifestCount: z.number().int().nonnegative().nullable(),
    deliveredCount: z.number().int().nonnegative().nullable(),
    gpsBatchCount: z.number().int().nonnegative(),
  }),

  /** 65-byte ECDSA signatures over the contract-derived digest. */
  driverSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  shipperSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/),

  attestedAt: z.string().datetime(),
});

export type Attestation = z.infer<typeof AttestationSchema>;

/** Mirrors ReputationLedger.Reputation exactly. */
export interface ReputationSummary {
  driver: string;
  totalTrips: number;
  onTimeTrips: number;
  disputeFreeTrips: number;
  onTimeRate: number;
  disputeFreeRate: number;
}

/**
 * Grace period before a delivery counts as late. Freight ETAs are estimates,
 * and penalising a driver for 20 minutes of traffic would make the whole
 * reputation signal noise.
 */
export const ON_TIME_GRACE_S = 3600;

export function deriveOnTime(
  scheduledArrivalTs: number | null,
  actualArrivalTs: number | null
): boolean {
  // Unknown schedule → do not penalise. Absence of evidence is not lateness.
  if (scheduledArrivalTs === null || actualArrivalTs === null) return true;
  return actualArrivalTs <= scheduledArrivalTs + ON_TIME_GRACE_S;
}

export function deriveDisputeFree(
  manifestCount: number | null,
  deliveredCount: number | null
): boolean {
  if (manifestCount === null || deliveredCount === null) return true;
  return deliveredCount >= manifestCount;
}

export function summarize(
  driver: string,
  r: { totalTrips: number; onTimeTrips: number; disputeFreeTrips: number }
): ReputationSummary {
  return {
    driver,
    ...r,
    onTimeRate: r.totalTrips > 0 ? r.onTimeTrips / r.totalTrips : 0,
    disputeFreeRate: r.totalTrips > 0 ? r.disputeFreeTrips / r.totalTrips : 0,
  };
}

/**
 * Minimum trips before a reputation score means anything. A driver with 2/2
 * clean trips is not more reliable than one with 180/200 — say "insufficient
 * history" rather than implying a perfect record.
 */
export const MIN_TRIPS_FOR_SCORE = 20;

export function isScoreMeaningful(totalTrips: number): boolean {
  return totalTrips >= MIN_TRIPS_FOR_SCORE;
}