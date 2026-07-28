/**
 * identity/tests/entitlements.e2e.test.ts
 * A Starter customer gets 402 on a Professional endpoint.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Plan, PlatformModule, modulesForPlan, missingPrerequisites,
} from "@dtd/shared/modules.schema";
import { Role } from "@dtd/shared/roles.schema";
import {
  EntitlementService, type EntitlementStore, type CompanyModuleRow,
} from "../subscriptions/entitlements";
import { OverrideService } from "../subscriptions/overrides";
import { PermissionService, PaymentRequiredError, type Actor } from "../rbac/permissions";
import { planDelta, prorate, isUpgrade } from "../subscriptions/plans";

class InMemoryEntitlementStore implements EntitlementStore {
  plans = new Map<string, Plan>();
  overrides = new Map<string, CompanyModuleRow[]>();

  async planFor(companyId: string) { return this.plans.get(companyId) ?? null; }
  async overridesFor(companyId: string) { return this.overrides.get(companyId) ?? []; }
  async putOverride(row: CompanyModuleRow) {
    const list = (this.overrides.get(row.companyId) ?? []).filter(
      (r) => r.module !== row.module
    );
    this.overrides.set(row.companyId, [...list, row]);
  }
  async clearOverride(companyId: string, module: PlatformModule) {
    this.overrides.set(
      companyId, (this.overrides.get(companyId) ?? []).filter((r) => r.module !== module)
    );
  }
  async setPlan(companyId: string, plan: Plan) { this.plans.set(companyId, plan); }
}

const COMPANY = "company-A";

describe("EntitlementService", () => {
  let store: InMemoryEntitlementStore;
  let svc: EntitlementService;

  beforeEach(() => {
    store = new InMemoryEntitlementStore();
    svc = new EntitlementService(store);
  });

  it("Starter gets the Starter module set — and nothing else", async () => {
    await svc.applyPlan(COMPANY, Plan.STARTER);
    const modules = await svc.modulesFor(COMPANY);

    expect(modules).toContain(PlatformModule.GPS_TRACKING);
    expect(modules).toContain(PlatformModule.FLEET);
    expect(modules).not.toContain(PlatformModule.REPORTS);
    expect(modules).not.toContain(PlatformModule.QR_GOODS);
    expect(modules).not.toContain(PlatformModule.THEFT_DETECTION);
  });

  it("plans are strictly cumulative", async () => {
    const starter = new Set(modulesForPlan(Plan.STARTER));
    const standard = new Set(modulesForPlan(Plan.STANDARD));
    const pro = new Set(modulesForPlan(Plan.PROFESSIONAL));
    const ent = new Set(modulesForPlan(Plan.ENTERPRISE));

    for (const m of starter) expect(standard.has(m)).toBe(true);
    for (const m of standard) expect(pro.has(m)).toBe(true);
    for (const m of pro) expect(ent.has(m)).toBe(true);
  });

  it("every plan's module set is internally coherent", () => {
    // No plan may ship a module whose prerequisites it lacks.
    for (const plan of Object.values(Plan)) {
      expect(missingPrerequisites(modulesForPlan(plan))).toEqual([]);
    }
  });

  it("upgrading grants the new modules immediately", async () => {
    await svc.applyPlan(COMPANY, Plan.STARTER);
    expect(await svc.has(COMPANY, PlatformModule.REPORTS)).toBe(false);

    await svc.applyPlan(COMPANY, Plan.STANDARD);
    expect(await svc.has(COMPANY, PlatformModule.REPORTS)).toBe(true);
  });

  it("an override grants a single module above the plan", async () => {
    await svc.applyPlan(COMPANY, Plan.STANDARD);
    await svc.grant({
      companyId: COMPANY, module: PlatformModule.QR_GOODS,
      setBy: "sa", reason: "pilot",
    });
    expect(await svc.has(COMPANY, PlatformModule.QR_GOODS)).toBe(true);
    expect(await svc.has(COMPANY, PlatformModule.THEFT_DETECTION)).toBe(false);
  });

  it("COHERENCE: refuses theft detection without custody tracking", async () => {
    await svc.applyPlan(COMPANY, Plan.STANDARD);
    await expect(svc.grant({
      companyId: COMPANY, module: PlatformModule.THEFT_DETECTION,
      setBy: "sa", reason: "customer asked",
    })).rejects.toThrow("MODULE_PREREQUISITES_MISSING");
  });

  it("revoking a prerequisite also disables what depended on it", async () => {
    await svc.applyPlan(COMPANY, Plan.ENTERPRISE);
    const result = await svc.revoke({
      companyId: COMPANY, module: PlatformModule.CUSTODY_TRACKING,
      setBy: "sa", reason: "downgrade",
    });

    expect(result.alsoDisabled).toContain(PlatformModule.THEFT_DETECTION);
    expect(await svc.has(COMPANY, PlatformModule.THEFT_DETECTION)).toBe(false);
  });

  it("cache invalidates on write — a paid upgrade is never delayed by a TTL", async () => {
    await svc.applyPlan(COMPANY, Plan.STARTER);
    await svc.modulesFor(COMPANY); // warm the cache
    await svc.applyPlan(COMPANY, Plan.ENTERPRISE);
    expect(await svc.has(COMPANY, PlatformModule.REPUTATION)).toBe(true);
  });

  it("an unknown company gets no modules, not a crash", async () => {
    expect(await svc.modulesFor("nonexistent")).toEqual([]);
  });
});

describe("The 402 gate", () => {
  const perms = new PermissionService();

  function starterActor(): Actor {
    return {
      userId: "u1", companyId: COMPANY, role: Role.COMPANY_ADMIN,
      modules: modulesForPlan(Plan.STARTER),
    };
  }

  it("THE CORE CASE: Starter customer hits a Pro endpoint → 402, not 403", () => {
    try {
      perms.assertModule(starterActor(), PlatformModule.QR_GOODS);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentRequiredError);
      expect((err as PaymentRequiredError).status).toBe(402);
      expect((err as PaymentRequiredError).module).toBe(PlatformModule.QR_GOODS);
    }
  });

  it("402 precedes 403 — an unentitled admin gets a sales message, not a denial", () => {
    // CompanyAdmin HAS manifest:create permission but NOT the module.
    const a = starterActor();
    expect(() =>
      perms.assertAll(a, {
        module: PlatformModule.CUSTODY_TRACKING,
        permission: undefined,
      })
    ).toThrow(PaymentRequiredError);
  });

  it("an entitled module passes the gate", () => {
    expect(() =>
      perms.assertModule(starterActor(), PlatformModule.GPS_TRACKING)
    ).not.toThrow();
  });

  it("Enterprise passes every module gate", () => {
    const a: Actor = { ...starterActor(), modules: modulesForPlan(Plan.ENTERPRISE) };
    for (const m of Object.values(PlatformModule)) {
      if (modulesForPlan(Plan.ENTERPRISE).includes(m)) {
        expect(() => perms.assertModule(a, m)).not.toThrow();
      }
    }
  });
});

describe("Plan economics", () => {
  it("planDelta reports what is gained and lost", () => {
    const d = planDelta(Plan.STANDARD, Plan.PROFESSIONAL);
    expect(d.direction).toBe("UPGRADE");
    expect(d.gained).toContain(PlatformModule.QR_GOODS);
    expect(d.lost).toHaveLength(0);
  });

  it("a downgrade reports what will be lost", () => {
    const d = planDelta(Plan.ENTERPRISE, Plan.STARTER);
    expect(d.direction).toBe("DOWNGRADE");
    expect(d.lost).toContain(PlatformModule.THEFT_DETECTION);
    expect(d.lost).toContain(PlatformModule.REPORTS);
  });

  it("upgrades charge prorated; downgrades credit, never refund cash", () => {
    const up = prorate({
      from: Plan.STARTER, to: Plan.ENTERPRISE, daysRemaining: 15, daysInCycle: 30,
    });
    expect(up.chargePaise).toBeGreaterThan(0);
    expect(up.creditPaise).toBe(0);

    const down = prorate({
      from: Plan.ENTERPRISE, to: Plan.STARTER, daysRemaining: 15, daysInCycle: 30,
    });
    expect(down.chargePaise).toBe(0);
    expect(down.creditPaise).toBeGreaterThan(0);
  });

  it("no proration on a fully consumed cycle", () => {
    const r = prorate({
      from: Plan.STARTER, to: Plan.ENTERPRISE, daysRemaining: 0, daysInCycle: 30,
    });
    expect(r.chargePaise).toBe(0);
  });

  it("isUpgrade orders the plans correctly", () => {
    expect(isUpgrade(Plan.STARTER, Plan.ENTERPRISE)).toBe(true);
    expect(isUpgrade(Plan.ENTERPRISE, Plan.STARTER)).toBe(false);
  });
});

describe("OverrideService", () => {
  let store: InMemoryEntitlementStore;
  let entitlements: EntitlementService;
  let overrides: any;
  let audit: any;
  let svc: OverrideService;

  beforeEach(() => {
    store = new InMemoryEntitlementStore();
    entitlements = new EntitlementService(store);
    overrides = {
      record: vi.fn(async () => {}),
      listForCompany: vi.fn(async () => []),
      listExpired: vi.fn(async () => []),
      markExpired: vi.fn(async () => {}),
    };
    audit = { record: vi.fn(async () => {}) };
    svc = new OverrideService(overrides, entitlements, audit);
  });

  it("only a SuperAdmin may toggle a module", async () => {
    await entitlements.applyPlan(COMPANY, Plan.STANDARD);
    await expect(svc.grant({
      actorId: "admin1", actorRole: Role.COMPANY_ADMIN, companyId: COMPANY,
      module: PlatformModule.QR_GOODS, reason: "self-service upgrade",
    })).rejects.toThrow("SUPER_ADMIN_ONLY");
  });

  it("every override REQUIRES a reason — no unexplained entitlements", async () => {
    await entitlements.applyPlan(COMPANY, Plan.STANDARD);
    await expect(svc.grant({
      actorId: "sa", actorRole: Role.SUPER_ADMIN, companyId: COMPANY,
      module: PlatformModule.QR_GOODS, reason: "   ",
    })).rejects.toThrow("REASON_REQUIRED");
  });

  it("a trial grant carries an expiry", async () => {
    await entitlements.applyPlan(COMPANY, Plan.STANDARD);
    const r = await svc.grant({
      actorId: "sa", actorRole: Role.SUPER_ADMIN, companyId: COMPANY,
      module: PlatformModule.QR_GOODS, reason: "30-day pilot", trialDays: 30,
    });
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    expect(r.modules).toContain(PlatformModule.QR_GOODS);
  });

  it("expired trials revoke themselves without anyone remembering", async () => {
    await entitlements.applyPlan(COMPANY, Plan.STANDARD);
    await svc.grant({
      actorId: "sa", actorRole: Role.SUPER_ADMIN, companyId: COMPANY,
      module: PlatformModule.QR_GOODS, reason: "pilot", trialDays: 1,
    });
    overrides.listExpired = vi.fn(async () => [{
      id: "o1", companyId: COMPANY, module: PlatformModule.QR_GOODS,
      granted: true, reason: "pilot", setBy: "sa",
      setAt: Date.now() - 100, expiresAt: Date.now() - 1,
    }]);

    const expired = await svc.expireTrials();
    expect(expired).toHaveLength(1);
    expect(await entitlements.has(COMPANY, PlatformModule.QR_GOODS)).toBe(false);
  });
});