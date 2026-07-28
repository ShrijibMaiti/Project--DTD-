/**
 * Cross-domain constants. Anything here is depended on by two or more domains;
 * single-domain values stay in their own module.
 */

// ---------------------------------------------------------------- identifiers

/** Crockford-style alphabet minus I, L, O, U — unambiguous when read aloud. */
export const SAFE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PIECE_ID_PREFIX = "DTD-";
export const PIECE_ID_LENGTH = 10;
export const PIECE_ID_PATTERN = /^DTD-[0-9A-HJ-NP-TV-Z]{10}$/;

export const COMPANY_CODE_PREFIX = "DTD-";
export const COMPANY_CODE_LENGTH = 6;
export const COMPANY_CODE_PATTERN = /^DTD-[0-9A-HJ-NP-TV-Z]{6}$/;

export const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

// ---------------------------------------------------------------- chain

/** Merkle batching window for GPS telemetry. */
export const BATCH_WINDOW_S = 3600;
/** Confirmations before an anchor is treated as final (reorg safety). */
export const ANCHOR_CONFIRMATIONS = 5;
/** Coordinates are fixed to 6 dp (~11 cm) as integers — floats never hashed. */
export const COORD_PRECISION = 1e6;

// ---------------------------------------------------------------- telemetry

export const EXPECTED_PING_INTERVAL_S = 30;
/** Silence beyond interval × this factor is a reportable gap. */
export const GAP_TOLERANCE_FACTOR = 4;
/** Device clock drift tolerated on ingest. */
export const MAX_CLOCK_SKEW_S = 120;
/** How far back an offline device may replay. */
export const MAX_BACKFILL_S = 24 * 3600;

// ---------------------------------------------------------------- custody

/** Co-sign links expire in one loading window, not one day. */
export const COSIGN_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_PIECES_PER_MANIFEST = 10_000;

// ---------------------------------------------------------------- auth

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;

// ---------------------------------------------------------------- money

/** Insurance cover ceiling, in paise. ₹50,00,000. */
export const MAX_COVER_PAISE = 500_000_000;
export const MIN_PREMIUM_PAISE = 29_900;
export const BILLING_CYCLE_DAYS = 30;
/** Dunning runs this long before downgrade — never cut off mid-trip. */
export const BILLING_GRACE_DAYS = 14;

// ---------------------------------------------------------------- rls

/** The three session variables. Referenced by name in SQL; typo-proofed here. */
export const SESSION_COMPANY_ID = "app.company_id";
export const SESSION_ACTOR_ROLE = "app.actor_role";
export const SESSION_IS_SYSTEM = "app.is_system";

// ---------------------------------------------------------------- errors

/** Wire-level error codes. Clients branch on these, not on message text. */
export const ERR = {
  MODULE_NOT_ENABLED: "MODULE_NOT_ENABLED",
  FORBIDDEN: "FORBIDDEN",
  MISSING_COMPANY_SCOPE: "MISSING_COMPANY_SCOPE",
  SHORT_DELIVERY: "SHORT_DELIVERY",
  CHAIN_SAYS_NOT_RELEASABLE: "CHAIN_SAYS_NOT_RELEASABLE",
  MANIFEST_NOT_FOUND: "MANIFEST_NOT_FOUND",
  NOT_IN_TRANSIT: "NOT_IN_TRANSIT",
  INVITE_EXPIRED: "INVITE_EXPIRED",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
} as const;

export type ErrorCode = (typeof ERR)[keyof typeof ERR];