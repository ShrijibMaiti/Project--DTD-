/**
 * platform/api/custody/participants.resolver.ts
 *
 * A5 — resolves the three signing addresses a manifest needs, and fails
 * LOUDLY and specifically when one is missing.
 *
 * WHY THIS EXISTS AS ITS OWN FILE
 * `drivers.signing_address` is nullable — the column comment says "set on
 * first key mint", and nothing has ever minted one, so in practice it is NULL
 * for every driver in the database. Phase B orchestration wants to source the
 * manifest's `driver` address from that column. Without this guard it would
 * pass `null` into CreateManifestDto and produce either an opaque Zod failure
 * or, worse, a malformed on-chain write that no one can ever sign against.
 *
 * The resolver is deliberately NOT wired into any route yet. It is the seam
 * Phase B plugs into, written now so that A5's failure mode is designed
 * rather than discovered.
 *
 * DESIGN NOTE — why this does not auto-mint keys.
 * It would be easy to call SignerService.ensureKey() here and silently create
 * a key for any driver who lacks one. That is wrong: minting a signing key is
 * an identity event that must be tied to a verified phone via OTP, not a side
 * effect of dispatching a truck. A driver whose key is minted without their
 * participation cannot meaningfully be said to have signed anything — which
 * would hollow out the entire custody chain. So: report, do not repair.
 */

import { BadRequestException, Injectable } from "@nestjs/common";
import type { Address } from "viem";
import { DatabaseService } from "../common/database.service";

export interface ResolvedParticipants {
  driver: Address;
  loader: Address;
  receiver: Address;
}

export interface ParticipantGap {
  role: "driver" | "loader" | "receiver";
  reason: "NO_SIGNING_KEY" | "NOT_ASSIGNED" | "NOT_SUPPLIED";
  subjectId: string | null;
  hint: string;
}

@Injectable()
export class ParticipantsResolver {
  constructor(private db: DatabaseService) {}

  /**
   * Returns either the three addresses or a precise list of what is missing.
   * Never throws for a missing key — the caller decides whether that is fatal
   * (orchestration) or merely reportable (a readiness check in the UI).
   */
  async resolve(
    companyId: string,
    bookingId: string,
    supplied: { loader?: string; receiver?: string }
  ): Promise<
    | { ok: true; participants: ResolvedParticipants }
    | { ok: false; gaps: ParticipantGap[] }
  > {
    const gaps: ParticipantGap[] = [];

    const driverRow = await this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `SELECT d.id, d.full_name, d.signing_address
         FROM bookings b
         LEFT JOIN drivers d ON d.id = b.driver_id
         WHERE b.id = $1`,
        [bookingId]
      );
      return rows[0] ?? null;
    });

    if (!driverRow || !driverRow.id) {
      gaps.push({
        role: "driver",
        reason: "NOT_ASSIGNED",
        subjectId: null,
        hint: "Assign a driver to this booking before creating a manifest.",
      });
    } else if (!driverRow.signing_address) {
      gaps.push({
        role: "driver",
        reason: "NO_SIGNING_KEY",
        subjectId: driverRow.id,
        hint:
          `Driver ${driverRow.full_name} has no signing key. The driver must ` +
          `complete one OTP verification to mint one — keys are never created ` +
          `on their behalf, because an unverified key cannot meaningfully sign.`,
      });
    }

    // loader and receiver are supplied per-shipment (the consignor's dock
    // staff and the consignee), not stored on the company. They arrive from
    // the caller; we only check they are present and well-formed.
    for (const role of ["loader", "receiver"] as const) {
      const value = supplied[role];
      if (!value) {
        gaps.push({
          role,
          reason: "NOT_SUPPLIED",
          subjectId: null,
          hint:
            `No ${role} address supplied. This is the counterparty's signing ` +
            `address, obtained when they accept their co-sign link.`,
        });
      }
    }

    if (gaps.length > 0) return { ok: false, gaps };

    return {
      ok: true,
      participants: {
        driver: driverRow.signing_address as Address,
        loader: supplied.loader as Address,
        receiver: supplied.receiver as Address,
      },
    };
  }

  /**
   * Orchestration variant: same resolution, but a gap is fatal and produces a
   * 400 whose message names the specific blocker rather than a schema error.
   */
  async resolveOrThrow(
    companyId: string,
    bookingId: string,
    supplied: { loader?: string; receiver?: string }
  ): Promise<ResolvedParticipants> {
    const result = await this.resolve(companyId, bookingId, supplied);
    if (result.ok) return result.participants;

    const primary = result.gaps[0];
    throw new BadRequestException({
      error: `${primary.role.toUpperCase()}_${primary.reason}`,
      message: primary.hint,
      gaps: result.gaps,
    });
  }
}
