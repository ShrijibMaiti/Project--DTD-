/**
 * identity/tests/rbac.e2e.test.ts
 * Each role sees EXACTLY its surface, no more.
 *
 * These tests are written adversarially on purpose: authorization bugs are
 * silent until they are catastrophic, so every test asks "what can this role
 * do that it must not?" rather than "does the happy path work?".
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Role, Permission, ROLE_PERMISSIONS } from "@dtd/shared/roles.schema";
import { PlatformModule, Plan, modulesForPlan } from "@dtd/shared/modules.schema";
import {
  PermissionService, ForbiddenError, PaymentRequiredError, type Actor,
} from "../rbac/permissions";
import { RoleService } from "../rbac/roles";
import { signAccessToken, verifyAccessToken, TokenError } from "../auth/jwt";

const SECRET = "test-jwt-secret";
process.env.JWT_SECRET = SECRET;

const enterprise = modulesForPlan(Plan.ENTERPRISE);

function actor(role: Role, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: `user-${role}`,
    companyId: role === Role.SUPER_ADMIN ? null : "company-A",
    role,
    modules: enterprise,
    ...overrides,
  };
}

describe("PermissionService — role surfaces", () => {
  const perms = new PermissionService();

  it("SuperAdmin can toggle modules; nobody else can", () => {
    expect(perms.can(actor(Role.SUPER_ADMIN), Permission.MODULE_TOGGLE)).toBe(true);
    for (const r of [Role.COMPANY_ADMIN, Role.DISPATCHER, Role.DRIVER, Role.RECEIVER]) {
      expect(perms.can(actor(r), Permission.MODULE_TOGGLE)).toBe(false);
    }
  });

  it("CompanyAdmin manages fleet and staff", () => {
    const a = actor(Role.COMPANY_ADMIN);
    expect(perms.can(a, Permission.FLEET_WRITE)).toBe(true);
    expect(perms.can(a, Permission.STAFF_INVITE)).toBe(true);
    expect(perms.can(a, Permission.TRIP_READ_ALL)).toBe(true);
  });

  it("DISPATCHER creates trips but CANNOT write fleet or invite staff", () => {
    const d = actor(Role.DISPATCHER);
    expect(perms.can(d, Permission.TRIP_CREATE)).toBe(true);
    expect(perms.can(d, Permission.TRIP_ASSIGN)).toBe(true);
    // the boundary that matters
    expect(perms.can(d, Permission.FLEET_WRITE)).toBe(false);
    expect(perms.can(d, Permission.STAFF_INVITE)).toBe(false);
    expect(perms.can(d, Permission.PAYMENT_COLLECT)).toBe(false);
    expect(perms.can(d, Permission.BILLING_VIEW)).toBe(false);
  });

  it("DRIVER sees only his own trips — never the company list", () => {
    const d = actor(Role.DRIVER);
    expect(perms.can(d, Permission.TRIP_READ_OWN)).toBe(true);
    expect(perms.can(d, Permission.TRIP_READ_ALL)).toBe(false);

    const scope = perms.tripScope(d);
    expect(scope).toEqual({ scope: "OWN", driverId: d.userId });
  });

  it("DISPATCHER's trip scope is ALL", () => {
    expect(perms.tripScope(actor(Role.DISPATCHER)).scope).toBe("ALL");
  });

  it("RECEIVER can scan and sign POD but nothing operational", () => {
    const r = actor(Role.RECEIVER);
    expect(perms.can(r, Permission.SCAN_SUBMIT)).toBe(true);
    expect(perms.can(r, Permission.POD_SIGN)).toBe(true);
    expect(perms.can(r, Permission.SHORTAGE_REPORT)).toBe(true);

    expect(perms.can(r, Permission.TRIP_CREATE)).toBe(false);
    expect(perms.can(r, Permission.TRIP_READ_ALL)).toBe(false);
    expect(perms.can(r, Permission.FLEET_READ)).toBe(false);
    expect(perms.can(r, Permission.DOCUMENT_GENERATE)).toBe(false);
    expect(() => perms.tripScope(r)).toThrow(ForbiddenError);
  });

  it("NOBODY except SuperAdmin holds a platform-administration permission", () => {
    const platformOnly = [
      Permission.COMPANY_CREATE,
      Permission.COMPANY_MANAGE_ALL,
      Permission.SUBSCRIPTION_MANAGE,
      Permission.MODULE_TOGGLE,
      Permission.PLATFORM_ANALYTICS_VIEW,
    ];
    for (const p of platformOnly) {
      for (const r of [Role.COMPANY_ADMIN, Role.DISPATCHER, Role.DRIVER, Role.RECEIVER]) {
        expect(ROLE_PERMISSIONS[r]).not.toContain(p);
      }
    }
  });

  it("no role grants a permission by omission — every list is explicit", () => {
    for (const role of Object.values(Role)) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });
});

describe("Tenant boundary", () => {
  const perms = new PermissionService();

  it("a CompanyAdmin cannot touch another company", () => {
    expect(() =>
      perms.assertSameCompany(actor(Role.COMPANY_ADMIN), "company-B")
    ).toThrow(ForbiddenError);
  });

  it("SuperAdmin crosses company boundaries by design", () => {
    expect(() =>
      perms.assertSameCompany(actor(Role.SUPER_ADMIN), "company-B")
    ).not.toThrow();
  });

  it("same-company access is allowed", () => {
    expect(() =>
      perms.assertSameCompany(actor(Role.DISPATCHER), "company-A")
    ).not.toThrow();
  });
});

describe("JWT claims", () => {
  it("round-trips role, company, and modules", () => {
    const token = signAccessToken({
      sub: "u1", companyId: "company-A", role: Role.DISPATCHER,
      modules: [PlatformModule.TRIPS], tokenVersion: 1,
    }, SECRET);

    const claims = verifyAccessToken(token, SECRET);
    expect(claims.role).toBe(Role.DISPATCHER);
    expect(claims.companyId).toBe("company-A");
    expect(claims.modules).toEqual([PlatformModule.TRIPS]);
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken({
      sub: "u1", companyId: "company-A", role: Role.DRIVER,
      modules: [], tokenVersion: 1,
    }, SECRET);

    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({
      sub: "u1", companyId: "company-A", role: Role.COMPANY_ADMIN,
      modules: [], tokenVersion: 1,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900,
    })).toString("base64url");

    expect(() => verifyAccessToken(`${h}.${forged}.${s}`, SECRET)).toThrow(TokenError);
  });

  it("STRUCTURAL GUARD: a non-SuperAdmin token without a company is rejected", () => {
    const token = signAccessToken({
      sub: "u1", companyId: null, role: Role.COMPANY_ADMIN,
      modules: [], tokenVersion: 1,
    }, SECRET);

    expect(() => verifyAccessToken(token, SECRET)).toThrow("MISSING_COMPANY_SCOPE");
  });

  it("rejects an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
      sub: "u1", companyId: "company-A", role: Role.DRIVER,
      modules: [], tokenVersion: 1, iat: now - 4000, exp: now - 100,
    })).toString("base64url");
    const sig = require("crypto")
      .createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");

    expect(() => verifyAccessToken(`${header}.${body}.${sig}`, SECRET)).toThrow("EXPIRED");
  });
});

describe("RoleService — escalation guards", () => {
  let users: any, roles: any, sessions: any, audit: any, svc: RoleService;

  beforeEach(() => {
    users = {
      byId: vi.fn(async (id: string) => ({
        id, companyId: "company-A", role: Role.DRIVER, status: "ACTIVE", tokenVersion: 1,
      })),
      bumpTokenVersion: vi.fn(async () => 2),
    };
    roles = { setRole: vi.fn(async () => {}), countByRole: vi.fn(async () => 3) };
    sessions = { logoutEverywhere: vi.fn(async () => 1) };
    audit = { record: vi.fn(async () => {}) };
    svc = new RoleService(roles, users, sessions, audit);
  });

  it("NOBODY can assign SUPER_ADMIN — not even a SuperAdmin, via this path", async () => {
    await expect(svc.changeRole({
      actorId: "sa", actorRole: Role.SUPER_ADMIN, actorCompanyId: null,
      targetUserId: "u1", newRole: Role.SUPER_ADMIN,
    })).rejects.toThrow("CANNOT_ASSIGN_ROLE");
  });

  it("a DISPATCHER cannot promote anyone", async () => {
    await expect(svc.changeRole({
      actorId: "d1", actorRole: Role.DISPATCHER, actorCompanyId: "company-A",
      targetUserId: "u1", newRole: Role.COMPANY_ADMIN,
    })).rejects.toThrow("CANNOT_ASSIGN_ROLE");
  });

  it("SELF-ESCALATION: a user cannot change his own role", async () => {
    users.byId = vi.fn(async () => ({
      id: "admin1", companyId: "company-A", role: Role.COMPANY_ADMIN,
      status: "ACTIVE", tokenVersion: 1,
    }));
    await expect(svc.changeRole({
      actorId: "admin1", actorRole: Role.COMPANY_ADMIN, actorCompanyId: "company-A",
      targetUserId: "admin1", newRole: Role.DISPATCHER,
    })).rejects.toThrow("CANNOT_CHANGE_OWN_ROLE");
  });

  it("CROSS-TENANT: an admin cannot re-role a user in another company", async () => {
    users.byId = vi.fn(async () => ({
      id: "u9", companyId: "company-B", role: Role.DRIVER,
      status: "ACTIVE", tokenVersion: 1,
    }));
    await expect(svc.changeRole({
      actorId: "admin1", actorRole: Role.COMPANY_ADMIN, actorCompanyId: "company-A",
      targetUserId: "u9", newRole: Role.DISPATCHER,
    })).rejects.toThrow("CROSS_COMPANY_FORBIDDEN");
  });

  it("refuses to remove the LAST CompanyAdmin", async () => {
    users.byId = vi.fn(async () => ({
      id: "u1", companyId: "company-A", role: Role.COMPANY_ADMIN,
      status: "ACTIVE", tokenVersion: 1,
    }));
    roles.countByRole = vi.fn(async () => 1);

    await expect(svc.changeRole({
      actorId: "admin2", actorRole: Role.COMPANY_ADMIN, actorCompanyId: "company-A",
      targetUserId: "u1", newRole: Role.DISPATCHER,
    })).rejects.toThrow("LAST_COMPANY_ADMIN");
  });

  it("a legitimate promotion forces re-login so the new role takes effect", async () => {
    await svc.changeRole({
      actorId: "admin1", actorRole: Role.COMPANY_ADMIN, actorCompanyId: "company-A",
      targetUserId: "u1", newRole: Role.DISPATCHER,
    });
    expect(roles.setRole).toHaveBeenCalledWith("u1", Role.DISPATCHER);
    expect(sessions.logoutEverywhere).toHaveBeenCalledWith("u1");
    expect(audit.record).toHaveBeenCalled();
  });
});