/**
 * identity/rbac/roles.ts
 * Role assignment and change, with the escalation rules that keep an admin
 * from minting a SuperAdmin or a dispatcher from promoting himself.
 */

import { Role, CROSS_TENANT_ROLES } from "@dtd/shared/roles.schema";
import type { UserStore } from "../auth/login";
import type { SessionService } from "../auth/session";

export interface RoleStore {
  setRole(userId: string, role: Role): Promise<void>;
  countByRole(companyId: string, role: Role): Promise<number>;
}

export interface RoleAudit {
  record(e: {
    actorId: string; targetUserId: string; companyId: string;
    from: Role; to: Role; at: number;
  }): Promise<void>;
}

/** Who may assign what. SuperAdmin is absent from every value list on purpose. */
const ASSIGNABLE_BY: Partial<Record<Role, Role[]>> = {
  [Role.SUPER_ADMIN]: [
    Role.COMPANY_ADMIN, Role.DISPATCHER, Role.DRIVER, Role.RECEIVER,
  ],
  [Role.COMPANY_ADMIN]: [
    Role.COMPANY_ADMIN, Role.DISPATCHER, Role.DRIVER, Role.RECEIVER,
  ],
};

export class RoleService {
  constructor(
    private roles: RoleStore,
    private users: UserStore,
    private sessions: SessionService,
    private audit: RoleAudit
  ) {}

  canAssign(actorRole: Role, targetRole: Role): boolean {
    return (ASSIGNABLE_BY[actorRole] ?? []).includes(targetRole);
  }

  async changeRole(input: {
    actorId: string;
    actorRole: Role;
    actorCompanyId: string | null;
    targetUserId: string;
    newRole: Role;
  }): Promise<{ userId: string; role: Role }> {
    if (!this.canAssign(input.actorRole, input.newRole)) {
      throw new Error(`CANNOT_ASSIGN_ROLE:${input.newRole}`);
    }

    const target = await this.users.byId(input.targetUserId);
    if (!target) throw new Error("USER_NOT_FOUND");

    // Tenant boundary: only SuperAdmin acts across companies.
    if (
      !CROSS_TENANT_ROLES.includes(input.actorRole) &&
      target.companyId !== input.actorCompanyId
    ) {
      throw new Error("CROSS_COMPANY_FORBIDDEN");
    }

    // Nobody demotes or re-roles a SuperAdmin through this path.
    if (target.role === Role.SUPER_ADMIN) {
      throw new Error("CANNOT_MODIFY_SUPER_ADMIN");
    }

    // Self-escalation guard.
    if (input.actorId === input.targetUserId && input.newRole !== target.role) {
      throw new Error("CANNOT_CHANGE_OWN_ROLE");
    }

    // Never leave a company with zero admins.
    if (target.role === Role.COMPANY_ADMIN && input.newRole !== Role.COMPANY_ADMIN) {
      const admins = await this.roles.countByRole(target.companyId!, Role.COMPANY_ADMIN);
      if (admins <= 1) throw new Error("LAST_COMPANY_ADMIN");
    }

    await this.roles.setRole(input.targetUserId, input.newRole);
    // Force re-issue: the old token still carries the old role for 15 minutes.
    await this.sessions.logoutEverywhere(input.targetUserId);

    await this.audit.record({
      actorId: input.actorId,
      targetUserId: input.targetUserId,
      companyId: target.companyId!,
      from: target.role,
      to: input.newRole,
      at: Date.now(),
    });

    return { userId: input.targetUserId, role: input.newRole };
  }
}