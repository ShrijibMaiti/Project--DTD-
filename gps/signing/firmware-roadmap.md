# GPS Signing Roadmap — Phase 1 → Phase 3

## Why this document exists

DTD's pitch is "records that cannot be tampered with." The GPS pipeline is the
one place where that claim currently rests on trusting DTD's own server. This
file states exactly where the trust boundary sits at each phase, so the claim
made to insurers and lenders never exceeds what the system proves.

## Tier 1 — Gateway signing (shipping now)

**Mechanism:** the ingestion gateway signs each ping on arrival with a
KMS-held key.

**Proves:** the ping has not been altered since DTD received it, and the
receipt time is fixed.

**Does not prove:** device origin. A compromised gateway key could fabricate
telemetry.

**Mitigations:** gateway key in AWS KMS, quarterly rotation, every signing
event audit-logged, anchoring is append-only so retroactive edits are visible.

**Honest phrasing for customers:** "tamper-evident from receipt onward."

## Tier 2 — Device MAC + gateway signing (shipping now, default)

**Mechanism:** each device holds a shared secret provisioned at installation
and HMACs every ping; the gateway verifies before signing.

**Proves:** the ping came from a device holding the secret, and is unaltered
since receipt.

**Does not prove:** resistance to secret extraction — shared secrets can be
pulled from unprotected firmware with physical access.

**Mitigations:** per-device secrets (never fleet-wide), rotation on suspicion,
tamper-flag counter auto-suspends a device after 20 failed MACs.

## Tier 3 — Secure-element signing (roadmap)

**Mechanism:** device signs with a private key generated inside a secure
element that cannot export it. Gateway becomes a relay.

**Proves:** device origin independent of DTD's infrastructure. This is the
tier at which "we ourselves cannot forge your telemetry" becomes literally true.

**Hardware paths, in order of practicality in India:**
1. **Telematics SIM with applet signing** — no new hardware; works with
   existing tracker + a SIM swap. Lowest friction, best first target.
2. **Tracker firmware + ATECC608-class secure element** — needs a hardware
   partner and a firmware build; strongest and cheapest at volume.
3. **GPS e-seal with onboard secure element** — solves signing and door
   tamper-evidence together; only worth it for high-value cargo.

**Migration constraints (do not break these):**
- The signature envelope is versioned (`DTDv1|<tier>|...`). Tier 3 devices
  emit the same envelope with tier=3; historical Tier 1/2 anchors stay valid.
- Merkle leaf construction must not change. Leaves hash the canonical ping
  plus the signature; a longer signature changes the leaf but not the scheme.
- Evidence packets always carry the tier and its disclosure string, so a
  claim assessor can see whether a given trip was Tier 1 or Tier 3.

## Decision trigger

Move to Tier 3 when any of: (a) the first insurer requires device-origin proof
for claim acceptance, (b) a disputed claim turns on gateway trust, or (c)
device count exceeds ~2,000 and per-unit secure-element cost drops below the
value of a single average claim. Until then, Tier 2 plus honest disclosure is
the right trade.