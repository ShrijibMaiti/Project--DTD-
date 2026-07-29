/**
 * Request shape after DtdAuthGuard. Replaces TenantRequest from the deleted
 * middleware; the name is kept as an alias so controller signatures don't all
 * have to change in the same commit.
 */
import type { Request } from "express";
import type { Actor } from "@dtd/identity/rbac/permissions";
import type { DtdClaims } from "@dtd/identity/auth/jwt";

export interface DtdRequest extends Request {
  actor: Actor;
  claims: DtdClaims;
}

/**
 * Legacy alias. `companyId` and `userId` are derived from actor so existing
 * controller bodies (`req.companyId`, `req.userId`) keep working unchanged.
 * Populated by AttachLegacyFields below.
 */
export interface TenantRequest extends DtdRequest {
  companyId: string;
  userId: string;
}