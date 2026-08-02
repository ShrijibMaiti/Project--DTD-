import type { Request } from "express";
import type { Actor } from "@dtd/identity/rbac/permissions";
import type { DtdClaims } from "@dtd/identity/auth/jwt";
import type { Role } from "@dtd/shared/roles.schema";
import type { PlatformModule } from "@dtd/shared/modules.schema";

export interface DtdRequest extends Request {
  actor: Actor;
  claims: DtdClaims;
}

/**
 * Legacy alias. companyId/userId/role/modules are flattened from actor by
 * DtdAuthGuard's shim so existing controllers keep working; the type now
 * matches what the guard actually populates.
 */
export interface TenantRequest extends DtdRequest {
  companyId: string;
  userId: string;
  role: Role;
  modules: PlatformModule[];
}