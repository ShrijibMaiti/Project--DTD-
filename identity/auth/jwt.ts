/**
 * identity/auth/jwt.ts
 * Token claims: {sub, companyId, role, modules[]}.
 *
 * Modules are baked into the token so the guard layer needs no DB hit on the
 * hot path — at the cost of staleness. That trade is made explicit: tokens are
 * short-lived (15 min) and a `tokenVersion` claim lets us force re-issue the
 * instant a subscription changes.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { Role } from "@dtd/shared/roles.schema";
import type { PlatformModule } from "@dtd/shared/modules.schema";

export interface DtdClaims {
  sub: string;             // userId
  companyId: string | null; // null ONLY for SuperAdmin
  role: Role;
  modules: PlatformModule[];
  tokenVersion: number;
  iat: number;
  exp: number;
}

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signAccessToken(
  claims: Omit<DtdClaims, "iat" | "exp">,
  secret = process.env.JWT_SECRET!
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: DtdClaims = { ...claims, iat: now, exp: now + ACCESS_TTL_S };

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export class TokenError extends Error {}

export function verifyAccessToken(
  token: string,
  secret = process.env.JWT_SECRET!
): DtdClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("MALFORMED_TOKEN");
  const [header, body, sig] = parts;

  const expected = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenError("BAD_SIGNATURE");
  }

  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as DtdClaims;
  if (claims.exp < Math.floor(Date.now() / 1000)) throw new TokenError("EXPIRED");

  // A non-SuperAdmin token without a company is structurally invalid — reject
  // rather than defaulting, because defaulting here would be a tenancy hole.
  if (claims.companyId === null && claims.role !== ("SUPER_ADMIN" as Role)) {
    throw new TokenError("MISSING_COMPANY_SCOPE");
  }
  return claims;
}