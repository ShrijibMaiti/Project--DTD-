# Key Rotation & Compromise Runbook — Project DTD

## Key inventory

| Key | Held by | Purpose | Blast radius if compromised |
|---|---|---|---|
| Platform relayer key | Backend (KMS) | Pays gas; relays signatures; onlyPlatform/onlyRegistrar/onlyAnchorer calls | Attacker can anchor garbage + relay, but CANNOT forge party signatures |
| Gateway signer key | GPS gateway (KMS) | Phase-1 signing of GPS pings | Attacker can fabricate telemetry until rotated |
| Participant keys | signer-service (encrypted at rest) | Loader/driver/shipper/receiver signatures | Forged custody/attestation sigs for THAT person only |
| Contract owner key | Cold wallet / multisig | setPlatform, setAnchorer, setRegistrar, arbiter changes | Full admin takeover — MOST critical |
| Escrow arbiter key | Ops multisig | Dispute resolution splits | Misdirected dispute funds |

## Rotation schedule (routine)

- Platform relayer + gateway signer: rotate **quarterly**.
  1. Generate new key in KMS.
  2. `setPlatform(new, true)` / `setAnchorer(new, true)` / `setRegistrar(new, true)`.
  3. Deploy config with new key; drain in-flight queue jobs.
  4. `set*(old, false)`. Old key revoked on-chain — historical anchors remain valid.
- Participant keys: NOT rotated routinely (the address IS the reputation).
  Rotation only on compromise or user-requested migration (see below).
- Owner key: multisig signers reviewed **yearly**; hardware wallets only.

## Compromise: platform / gateway key

1. IMMEDIATELY `set*(compromised, false)` from owner multisig.
2. Freeze anchor-worker queue.
3. Audit window: every tx from the compromised key between suspected-leak
   time and revocation. Mark affected batches/documents as UNTRUSTED in the
   platform DB (chain history cannot be deleted — it is annotated instead).
4. Rotate per schedule steps; resume queue; post-mortem within 72h.

## Compromise: participant key

1. Suspend the phone->key mapping in signer-service (no new signatures).
2. Issue a fresh keypair for the participant.
3. Reputation migration: platform publishes a signed link-record
   (old address -> new address) in the platform DB and includes it in
   lender/insurer verification responses. On-chain history stays with the
   old address; the link record carries the continuity.
4. Any signature produced after the reported-compromise timestamp is
   treated as void in dispute resolution.

## Compromise: owner key

- Owner MUST be a 2-of-3 multisig before mainnet. Single-signer owner is
  acceptable ONLY on testnet.
- On compromise of one signer: rotate that signer out via the multisig.
- On loss of quorum: contracts remain functional but frozen for admin
  changes — document this risk to clients; this is by design (no backdoor).

## Invariants (never violate)

- Private keys never leave KMS / encrypted storage unencrypted, except via
  the OTP-gated, audit-logged exportKey() path.
- No key material in env files, logs, error messages, or crash dumps.
- Every signature event has an audit row BEFORE the signature is released.
- Revocation is always on-chain (set* false), never just config removal.