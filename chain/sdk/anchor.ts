/**
 * chain/sdk/anchor.ts
 * The ONE gateway between the platform and the chain.
 * Implements shared/anchor.interface.ts — every hash in DTD
 * (GPS batch root, document, manifest, attestation) passes through here.
 * Swap the chain (Polygon <-> Base) by changing config only.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy, polygon } from "viem/chains";

// ---------------------------------------------------------------- config

const CHAIN = process.env.DTD_NETWORK === "mainnet" ? polygon : polygonAmoy;
const RPC_URL = process.env.DTD_RPC_URL!;
const PLATFORM_KEY = process.env.DTD_PLATFORM_PRIVATE_KEY! as Hex; // KMS-fetched in prod

export const ADDRESSES = {
  tripLogAnchor: process.env.DTD_TRIPLOG_ADDR! as Address,
  documentRegistry: process.env.DTD_DOCREG_ADDR! as Address,
  custodyManifest: process.env.DTD_CUSTODY_ADDR! as Address,
  reputationLedger: process.env.DTD_REPUTATION_ADDR! as Address,
  escrow: process.env.DTD_ESCROW_ADDR! as Address,
};

// ---------------------------------------------------------------- ABIs (human-readable, minimal)

export const tripLogAbi = parseAbi([
  "function anchorBatch(bytes32 tripId, bytes32 root, uint64 fromTs, uint64 toTs) returns (uint256)",
  "function batchCount(bytes32 tripId) view returns (uint256)",
  "function getBatch(bytes32 tripId, uint256 index) view returns ((bytes32 root, uint64 fromTs, uint64 toTs, uint64 anchoredAt))",
  "function verifyPing(bytes32 tripId, uint256 batchIndex, bytes32 leaf, bytes32[] proof) view returns (bool)",
]);

export const docRegAbi = parseAbi([
  "function registerDocument(bytes32 docHash, bytes32 tripId, uint8 docType)",
  "function isRegistered(bytes32 docHash) view returns (bool)",
  "function getDocument(bytes32 docHash) view returns ((bytes32 tripId, uint8 docType, address submitter, uint64 registeredAt, bool exists))",
]);

export const custodyAbi = parseAbi([
  "function createManifest(bytes32 manifestId, bytes32 tripId, uint32 pieceCount, address loader, address driver, address receiver)",
  "function submitLoaderSignature(bytes32 manifestId, bytes sig)",
  "function submitDriverSignature(bytes32 manifestId, bytes sig)",
  "function confirmDelivery(bytes32 manifestId, uint32 deliveredCount, bytes receiverSig)",
  "function markDisputed(bytes32 manifestId)",
  "function loadingDigest(bytes32 manifestId) view returns (bytes32)",
  "function deliveryDigest(bytes32 manifestId, uint32 deliveredCount) view returns (bytes32)",
  "function isReleasable(bytes32 manifestId) view returns (bool)",
  "function status(bytes32 manifestId) view returns (uint8)",
]);

export const reputationAbi = parseAbi([
  "function attest(bytes32 tripId, address driver, address shipper, bool onTime, bool disputeFree, bytes driverSig, bytes shipperSig)",
  "function attestationDigest(bytes32 tripId, address driver, address shipper, bool onTime, bool disputeFree) view returns (bytes32)",
  "function getReputation(address driver) view returns ((uint32 totalTrips, uint32 onTimeTrips, uint32 disputeFreeTrips))",
]);

// ---------------------------------------------------------------- clients

const account = privateKeyToAccount(PLATFORM_KEY);

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: CHAIN,
  transport: http(RPC_URL),
});

// ---------------------------------------------------------------- types

export enum DocType {
  Manifest = 0,
  Bilty = 1,
  POD = 2,
  Invoice = 3,
}

// ---------------------------------------------------------------- core API

async function send(txPromise: Promise<Hex>): Promise<Hex> {
  const hash = await txPromise;
  // Wait for 1 confirmation; the anchor-worker handles retries/reorgs on top.
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Anchor one hourly Merkle root of signed GPS pings. */
export async function anchorTripBatch(
  tripId: Hex,
  root: Hex,
  fromTs: number,
  toTs: number
): Promise<Hex> {
  return send(
    walletClient.writeContract({
      address: ADDRESSES.tripLogAnchor,
      abi: tripLogAbi,
      functionName: "anchorBatch",
      args: [tripId, root, BigInt(fromTs), BigInt(toTs)],
    })
  );
}

/** Fingerprint a Bilty/POD/Invoice/Manifest file on-chain. */
export async function registerDocument(
  docHash: Hex,
  tripId: Hex,
  docType: DocType
): Promise<Hex> {
  return send(
    walletClient.writeContract({
      address: ADDRESSES.documentRegistry,
      abi: docRegAbi,
      functionName: "registerDocument",
      args: [docHash, tripId, docType],
    })
  );
}

/** Open a custody manifest for a trip. */
export async function createManifest(
  manifestId: Hex,
  tripId: Hex,
  pieceCount: number,
  loader: Address,
  driver: Address,
  receiver: Address
): Promise<Hex> {
  return send(
    walletClient.writeContract({
      address: ADDRESSES.custodyManifest,
      abi: custodyAbi,
      functionName: "createManifest",
      args: [manifestId, tripId, pieceCount, loader, driver, receiver],
    })
  );
}

/** Relay a party's OTP-produced signature to the custody contract. */
export async function submitSignature(
  role: "loader" | "driver",
  manifestId: Hex,
  sig: Hex
): Promise<Hex> {
  return send(
    walletClient.writeContract({
      address: ADDRESSES.custodyManifest,
      abi: custodyAbi,
      functionName:
        role === "loader" ? "submitLoaderSignature" : "submitDriverSignature",
      args: [manifestId, sig],
    })
  );
}

/** Receiver's scanned count + signature -> Delivered or Short. */
export async function confirmDelivery(
  manifestId: Hex,
  deliveredCount: number,
  receiverSig: Hex
): Promise<Hex> {
  return send(
    walletClient.writeContract({
      address: ADDRESSES.custodyManifest,
      abi: custodyAbi,
      functionName: "confirmDelivery",
      args: [manifestId, deliveredCount, receiverSig],
    })
  );
}

/** Dual-signed trip attestation -> ReputationLedger. */
export async function submitAttestation(params: {
  tripId: Hex;
  driver: Address;
  shipper: Address;
  onTime: boolean;
  disputeFree: boolean;
  driverSig: Hex;
  shipperSig: Hex;
}): Promise<Hex> {
  return send(
    walletClient.writeContract({
      address: ADDRESSES.reputationLedger,
      abi: reputationAbi,
      functionName: "attest",
      args: [
        params.tripId,
        params.driver,
        params.shipper,
        params.onTime,
        params.disputeFree,
        params.driverSig,
        params.shipperSig,
      ],
    })
  );
}

/** Read the digests parties must sign (served to signer-service). */
export async function getLoadingDigest(manifestId: Hex): Promise<Hex> {
  return publicClient.readContract({
    address: ADDRESSES.custodyManifest,
    abi: custodyAbi,
    functionName: "loadingDigest",
    args: [manifestId],
  });
}

export async function getDeliveryDigest(
  manifestId: Hex,
  deliveredCount: number
): Promise<Hex> {
  return publicClient.readContract({
    address: ADDRESSES.custodyManifest,
    abi: custodyAbi,
    functionName: "deliveryDigest",
    args: [manifestId, deliveredCount],
  });
}

export async function getAttestationDigest(params: {
  tripId: Hex;
  driver: Address;
  shipper: Address;
  onTime: boolean;
  disputeFree: boolean;
}): Promise<Hex> {
  return publicClient.readContract({
    address: ADDRESSES.reputationLedger,
    abi: reputationAbi,
    functionName: "attestationDigest",
    args: [
      params.tripId,
      params.driver,
      params.shipper,
      params.onTime,
      params.disputeFree,
    ],
  });
}