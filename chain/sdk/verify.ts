/**
 * chain/sdk/verify.ts
 * Read-only verification API — what the bank, insurer, and lender portal use.
 * No keys required: anyone can verify, no one can forge.
 */

import { keccak256, type Hex, type Address } from "viem";
import {
  publicClient,
  ADDRESSES,
  tripLogAbi,
  docRegAbi,
  custodyAbi,
  reputationAbi,
} from "./anchor";
import { pingLeaf, type GpsPing } from "./merkle";

// ---------------------------------------------------------------- documents

/** Hash raw file bytes exactly as the registrar did. */
export function hashDocument(fileBytes: Uint8Array): Hex {
  return keccak256(fileBytes);
}

/**
 * The 2-second bank check: "is this exact file genuine and unaltered?"
 * Returns registration record, or null if the file was never registered
 * (or was altered by even one byte).
 */
export async function verifyDocument(fileBytes: Uint8Array) {
  const docHash = hashDocument(fileBytes);
  const registered = await publicClient.readContract({
    address: ADDRESSES.documentRegistry,
    abi: docRegAbi,
    functionName: "isRegistered",
    args: [docHash],
  });
  if (!registered) return null;

  const doc = await publicClient.readContract({
    address: ADDRESSES.documentRegistry,
    abi: docRegAbi,
    functionName: "getDocument",
    args: [docHash],
  });
  return { docHash, ...doc };
}

// ---------------------------------------------------------------- GPS proofs

/**
 * Insurer question: "was truck X at location Y at time T?"
 * Verifies one revealed ping against its anchored batch root —
 * without exposing any other point on the route.
 */
export async function verifyPingOnChain(
  tripId: Hex,
  batchIndex: number,
  ping: GpsPing,
  proof: Hex[]
): Promise<boolean> {
  return publicClient.readContract({
    address: ADDRESSES.tripLogAnchor,
    abi: tripLogAbi,
    functionName: "verifyPing",
    args: [tripId, BigInt(batchIndex), pingLeaf(ping), proof],
  });
}

// ---------------------------------------------------------------- custody

export async function getManifestStatus(manifestId: Hex): Promise<number> {
  return publicClient.readContract({
    address: ADDRESSES.custodyManifest,
    abi: custodyAbi,
    functionName: "status",
    args: [manifestId],
  });
}

export async function isReleasable(manifestId: Hex): Promise<boolean> {
  return publicClient.readContract({
    address: ADDRESSES.custodyManifest,
    abi: custodyAbi,
    functionName: "isReleasable",
    args: [manifestId],
  });
}

// ---------------------------------------------------------------- reputation

/** The portable track record — readable by any platform or lender. */
export async function getDriverReputation(driver: Address) {
  const rep = await publicClient.readContract({
    address: ADDRESSES.reputationLedger,
    abi: reputationAbi,
    functionName: "getReputation",
    args: [driver],
  });
  const { totalTrips, onTimeTrips, disputeFreeTrips } = rep;
  return {
    totalTrips,
    onTimeTrips,
    disputeFreeTrips,
    onTimeRate: totalTrips > 0 ? onTimeTrips / totalTrips : 0,
    disputeFreeRate: totalTrips > 0 ? disputeFreeTrips / totalTrips : 0,
  };
}