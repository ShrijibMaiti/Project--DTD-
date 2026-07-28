/**
 * identity/rbac/permissions.ts
 * Implements shared/roles.schema.ts. The single place any code asks
 * "may this actor do this?".
 */

import {
  Role, Permission, permissionsFor, roleHas, CROSS_TENANT_ROLES,
} from "@dtd/shared/roles.schema";
import type { PlatformModule } from "@dtd/shared/modules.schema";

export interface Actor {
  userId: string;
  companyId: string | null;
  role: Role;
  modules: PlatformModule[];
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(public readonly detail: string) {
    super(`FORBIDDEN:${detail}`);
  }
}

export class PaymentRequiredError extends Error {
  readonly status = 402;
  constructor(public readonly module: PlatformModule) {
    super(`MODULE_NOT_ENABLED:${module}`);
  }
}

export class PermissionService {
  can(actor: Actor, permission: Permission): boolean {
    return roleHas(actor.role, permission);
  }

  assert(actor: Actor, permission: Permission): void {
    if (!this.can(actor, permission)) {
      throw new ForbiddenError(`${actor.role} lacks ${permission}`);
    }
  }

  hasModule(actor: Actor, module: PlatformModule): boolean {
    return actor.modules.includes(module);
  }

  assertModule(actor: Actor, module: PlatformModule): void {
    if (!this.hasModule(actor, module)) throw new PaymentRequiredError(module);
  }

  /**
   * The combined gate every controller uses. Order matters: check the
   * subscription FIRST so an unentitled customer gets a 402 ("upgrade") rather
   * than a 403 ("you're not allowed") — one is a sales conversation, the
   * other is a support ticket.
   */
  assertAll(
    actor: Actor,
    opts: { permission?: Permission; module?: PlatformModule; companyId?: string }
  ): void {
    if (opts.module) this.assertModule(actor, opts.module);
    if (opts.permission) this.assert(actor, opts.permission);
    if (opts.companyId) this.assertSameCompany(actor, opts.companyId);
  }

  /** Tenant boundary check, independent of RLS — belt and braces. */
  assertSameCompany(actor: Actor, companyId: string): void {
    if (CROSS_TENANT_ROLES.includes(actor.role)) return;
    if (actor.companyId !== companyId) {
      throw new ForbiddenError("cross-company access");
    }
  }

  /**
   * Row-scope helper for roles that see only their own records.
   * A Driver with TRIP_READ_OWN must never receive a company-wide list.
   */
  tripScope(actor: Actor): { scope: "ALL" | "OWN"; driverId?: string } {
    if (this.can(actor, Permission.TRIP_READ_ALL)) return { scope: "ALL" };
    if (this.can(actor, Permission.TRIP_READ_OWN)) {
      return { scope: "OWN", driverId: actor.userId };
    }
    throw new ForbiddenError("no trip read permission");
  }

  listPermissions(role: Role): Permission[] {
    return permissionsFor(role);
  }
}