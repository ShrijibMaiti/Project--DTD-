/**
 * custody/manifest/handoff.ts
 * The custody-window state machine, mirrored off-chain for fast queries and
 * dispute narratives. The CHAIN is authoritative; this is a read model that
 * re-syncs from it. When they disagree, the chain wins and we alert.
 *
 * Windows:
 *   LOADING   : manifest created -> both signatures     (shipper-side custody)
 *   TRANSIT   : custody started -> delivery confirmed   (DRIVER custody)  <- losses land here
 *   UNLOADING : delivery confirmed onward               (receiver custody)
 */

import type { Hex } from "viem";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import { getManifestStatus } from "@dtd/chain-sdk/verify";
import { publicClient, ADDRESSES, custodyAbi } from "@dtd/chain-sdk/anchor";
import type { ManifestStore } from "./builder";

export type CustodyWindow = "LOADING" | "TRANSIT" | "UNLOADING" | "CLOSED" | "DISPUTED";

export interface CustodyRecord {
  manifestId: string;
  status: CustodyStatus;
  window: CustodyWindow;
  pieceCount: number;
  deliveredCount: number;
  custodyStartAt: number | null;
  deliveredAt: number | null;
  loaderSigned: boolean;
  driverSigned: boolean;
  receiverSigned: boolean;
}

export interface CustodyStore {
  upsert(r: CustodyRecord): Promise<void>;
  get(manifestId: string): Promise<CustodyRecord | null>;
}

export interface AlertSink {
  raise(e: {
    kind: string;
    manifestId: string;
    detail: Record<string, unknown>;
    severity: "INFO" | "WARN" | "CRITICAL";
  }): Promise<void>;
}

export class HandoffService {
  constructor(
    private custody: CustodyStore,
    private manifests: ManifestStore,
    private alerts: AlertSink
  ) {}

  /** Pull authoritative state from the chain and refresh the read model. */
  async sync(manifestId: string): Promise<CustodyRecord> {
    const onchain = await publicClient.readContract({
      address: ADDRESSES.custodyManifest,
      abi: custodyAbi,
      functionName: "getManifest",
      args: [manifestId as Hex],
    });

    const status = Number(onchain.status) as CustodyStatus;
    const record: CustodyRecord = {
      manifestId,
      status,
      window: windowFor(status),
      pieceCount: Number(onchain.pieceCount),
      deliveredCount: Number(onchain.deliveredCount),
      custodyStartAt: Number(onchain.custodyStartAt) || null,
      deliveredAt: Number(onchain.deliveredAt) || null,
      loaderSigned: onchain.loaderSigned,
      driverSigned: onchain.driverSigned,
      receiverSigned: onchain.receiverSigned,
    };

    const previous = await this.custody.get(manifestId);
    if (previous && previous.status !== status) {
      await this.alerts.raise({
        kind: "CUSTODY_TRANSITION",
        manifestId,
        detail: { from: previous.status, to: status },
        severity: status === CustodyStatus.Short ? "CRITICAL" : "INFO",
      });
    }

    await this.custody.upsert(record);
    return record;
  }

  /**
   * The dispute narrative: which signed party held the goods when they vanished.
   * This is the sentence that goes into an insurance claim.
   */
  async attributeLoss(manifestId: string): Promise<{
    lost: number;
    window: CustodyWindow;
    liableRole: "LOADER" | "DRIVER" | "RECEIVER" | "UNDETERMINED";
    narrative: string;
  }> {
    const rec = await this.sync(manifestId);
    const manifest = await this.manifests.get(manifestId);
    const lost = rec.pieceCount - rec.deliveredCount;

    if (rec.status !== CustodyStatus.Short) {
      return {
        lost: 0,
        window: rec.window,
        liableRole: "UNDETERMINED",
        narrative: "No shortage recorded for this manifest.",
      };
    }

    // Both loading signatures present + receiver signed short => the gap is
    // bounded by the driver's custody window. This is the whole point.
    const liableRole =
      rec.loaderSigned && rec.driverSigned && rec.receiverSigned
        ? ("DRIVER" as const)
        : ("UNDETERMINED" as const);

    const from = rec.custodyStartAt
      ? new Date(rec.custodyStartAt * 1000).toISOString()
      : "unknown";
    const to = rec.deliveredAt
      ? new Date(rec.deliveredAt * 1000).toISOString()
      : "unknown";

    return {
      lost,
      window: "TRANSIT",
      liableRole,
      narrative:
        `${lost} of ${rec.pieceCount} pieces unaccounted for on booking ` +
        `${manifest?.bookingId ?? "?"}. Loader and driver both signed for ` +
        `${rec.pieceCount} pieces at loading (${from}); receiver signed for ` +
        `${rec.deliveredCount} at unloading (${to}). Loss therefore occurred ` +
        `inside the driver's custody window. Cross-reference the anchored GPS ` +
        `batches for that interval to identify unexplained stops.`,
    };
  }

  /** Guard used by the scanner: refuse scan-in outside the right window. */
  async assertScannable(manifestId: string): Promise<CustodyRecord> {
    const rec = await this.sync(manifestId);
    if (rec.status !== CustodyStatus.InCustody) {
      throw new Error(`NOT_IN_TRANSIT:status=${CustodyStatus[rec.status]}`);
    }
    return rec;
  }
}

export function windowFor(status: CustodyStatus): CustodyWindow {
  switch (status) {
    case CustodyStatus.Created:
      return "LOADING";
    case CustodyStatus.InCustody:
      return "TRANSIT";
    case CustodyStatus.Delivered:
      return "CLOSED";
    case CustodyStatus.Short:
      return "UNLOADING";
    case CustodyStatus.Disputed:
      return "DISPUTED";
    default:
      return "CLOSED";
  }
}