/**
 * gps/query/proof-api.ts
 * Selective disclosure: "was truck X at location Y at 2 AM?"
 *
 * The insurer gets ONE ping plus a Merkle proof. They can verify it against
 * the anchored root themselves — and they learn nothing about the rest of the
 * route. This is what makes anchored telemetry safe to share with third
 * parties at all.
 */

import type { Hex } from "viem";
import { publicClient, ADDRESSES, tripLogAbi } from "@dtd/chain-sdk/anchor";
import { buildTree, proofFor, pingLeaf } from "../batching/merkle-batcher";
import { haversineM } from "../journey/stop-detector";
import type { SignedPing } from "../signing/gateway-signer";
import { TRUST_DISCLOSURE } from "../signing/gateway-signer";

export interface PingProof {
  ping: {
    lat: number;
    lng: number;
    ts: number;
    speedKph?: number;
    deviceId: string;
    signerTier: number;
    gatewaySig: string;
  };
  leaf: Hex;
  proof: Hex[];
  batchIndex: number;
  root: Hex;
  contractAddress: string;
  disclosure: string;
  /** Anyone can re-run this themselves; we state it for convenience. */
  verifiedOnChain: boolean;
}

export interface PingSource {
  /** All pings in the batch that contains ts — needed to rebuild the tree. */
  batchPingsAt(tripId: string, ts: number): Promise<{
    pings: SignedPing[];
    batchIndex: number;
  } | null>;
  pingsInWindow(tripId: string, fromTs: number, toTs: number): Promise<SignedPing[]>;
}

export class ProofApi {
  constructor(private source: PingSource) {}

  /** Prove one moment. The core primitive. */
  async proveMoment(tripId: string, ts: number): Promise<PingProof | null> {
    const batch = await this.source.batchPingsAt(tripId, ts);
    if (!batch || batch.pings.length === 0) return null;

    // Nearest ping to the requested instant.
    const target = batch.pings.reduce((best, p) =>
      Math.abs(p.ts - ts) < Math.abs(best.ts - ts) ? p : best
    );

    const tree = buildTree(batch.pings);
    const proof = proofFor(tree, target);
    const leaf = pingLeaf(target);

    const onchainBatch = await publicClient.readContract({
      address: ADDRESSES.tripLogAnchor,
      abi: tripLogAbi,
      functionName: "getBatch",
      args: [tripId as Hex, BigInt(batch.batchIndex)],
    });

    const verifiedOnChain = await publicClient.readContract({
      address: ADDRESSES.tripLogAnchor,
      abi: tripLogAbi,
      functionName: "verifyPing",
      args: [tripId as Hex, BigInt(batch.batchIndex), leaf, proof],
    });

    return {
      ping: {
        lat: target.lat,
        lng: target.lng,
        ts: target.ts,
        speedKph: target.speedKph,
        deviceId: target.deviceId,
        signerTier: target.signerTier,
        gatewaySig: target.gatewaySig,
      },
      leaf,
      proof,
      batchIndex: batch.batchIndex,
      root: onchainBatch.root,
      contractAddress: ADDRESSES.tripLogAnchor,
      disclosure: TRUST_DISCLOSURE[target.signerTier],
      verifiedOnChain,
    };
  }

  /**
   * The insurer's actual question, phrased as they'd ask it:
   * "was the vehicle within N metres of this location at this time?"
   * Answers yes/no AND hands over the proof, so the answer is checkable.
   */
  async wasVehicleNear(params: {
    tripId: string;
    lat: number;
    lng: number;
    ts: number;
    radiusM: number;
  }): Promise<{
    answer: boolean | null;
    distanceM: number | null;
    proof: PingProof | null;
    note: string;
  }> {
    const proof = await this.proveMoment(params.tripId, params.ts);
    if (!proof) {
      return {
        answer: null,
        distanceM: null,
        proof: null,
        note: "No anchored telemetry covers that moment. This may indicate a device gap — see the trip's gap report.",
      };
    }

    // Guard against answering from a ping that is far from the asked-for time.
    const drift = Math.abs(proof.ping.ts - params.ts);
    if (drift > 300) {
      return {
        answer: null,
        distanceM: null,
        proof,
        note: `Nearest anchored ping is ${Math.round(drift / 60)} minutes from the requested time; too far to answer reliably.`,
      };
    }

    const distanceM = haversineM(
      params.lat, params.lng, proof.ping.lat, proof.ping.lng
    );

    return {
      answer: distanceM <= params.radiusM,
      distanceM: Math.round(distanceM),
      proof,
      note: proof.verifiedOnChain
        ? "Proof verified against the on-chain root."
        : "WARNING: proof did NOT verify on-chain — do not rely on this record.",
    };
  }

  /**
   * Window disclosure for claims: every anchored ping between two timestamps,
   * each with its own proof. Used when a claim turns on a period rather than
   * an instant — e.g. the custody window a shortage was pinned to.
   */
  async proveWindow(
    tripId: string,
    fromTs: number,
    toTs: number,
    maxPoints = 50
  ): Promise<{ points: PingProof[]; truncated: boolean }> {
    const pings = await this.source.pingsInWindow(tripId, fromTs, toTs);
    const step = Math.max(1, Math.ceil(pings.length / maxPoints));
    const sampled = pings.filter((_, i) => i % step === 0);

    const points: PingProof[] = [];
    for (const p of sampled) {
      const proof = await this.proveMoment(tripId, p.ts);
      if (proof) points.push(proof);
    }
    return { points, truncated: sampled.length < pings.length };
  }
}