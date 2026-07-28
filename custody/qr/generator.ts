/**
 * custody/qr/generator.ts
 * Per-piece ID minting + QR payload construction.
 *
 * Design notes:
 *  - Crockford-style alphabet minus I/L/O/U: no ambiguity when a dock worker
 *    reads an ID aloud over a phone.
 *  - IDs are RANDOM, not sequential: sequential IDs let a thief guess valid
 *    neighbours and print plausible fakes.
 *  - The QR encodes a URL, so ANY phone camera opens the public verify page
 *    even without our app — that is what turns the market into a sensor net.
 */

import { randomBytes } from "crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 chars, no I L O U
const ID_LEN = 10;

export function generatePieceId(): string {
  const bytes = randomBytes(ID_LEN);
  let s = "";
  for (let i = 0; i < ID_LEN; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `DTD-${s}`;
}

export function generatePieceIds(n: number): string[] {
  if (n <= 0) throw new Error("PIECE_COUNT_MUST_BE_POSITIVE");
  if (n > 10_000) throw new Error("PIECE_COUNT_TOO_LARGE");
  const set = new Set<string>();
  while (set.size < n) set.add(generatePieceId());
  return [...set];
}

/** The QR payload: a public verify URL. Scannable by any camera app. */
export function qrPayload(pieceId: string, baseUrl = process.env.APP_BASE_URL!): string {
  return `${baseUrl}/v/${pieceId}`;
}

/**
 * Human-readable check for dock workers reading IDs aloud.
 * Not security — just typo detection.
 */
export function checkDigit(pieceId: string): string {
  const body = pieceId.replace("DTD-", "");
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 1);
  return ALPHABET[sum % ALPHABET.length];
}

export function isWellFormedPieceId(id: string): boolean {
  return /^DTD-[0-9A-HJ-NP-TV-Z]{10}$/.test(id);
}