/**
 * identity/subscriptions/entitlements.ts
 * The per-company module map — the gate every API reads.
 *
 * Effective modules = plan modules ∪ granted overrides − revoked overrides.
 * Cached, because this is on the hot path of every login and refresh; the
 * cache is invalidated explicitly on every write rather than expiring, since
 * a customer who paid for an upgrade should not wait for a TTL.
 */

import {
  Plan, PlatformModule, modulesForPlan, missingPrerequisites,
} from "@dtd/shared/modules.schema";

export interface CompanyModuleRow {
  companyId: string;
  module: PlatformModule;
  granted: boolean;       // false = explicitly revoked despite the plan
  reason: string | null;
  setBy: string;
  setAt: number;
}

export interface EntitlementStore {
  planFor(companyId: string): Promise<Plan | null>;
  overridesFor(companyId: string): Promise<CompanyModuleRow[]>;
  putOverride(row: CompanyModuleRow): Promise<void>;
  clearOverride(companyId: string, module: PlatformModule): Promise<void>;
  setPlan(companyId: string, plan: Plan): Promise<void>;
}

export class EntitlementService {
  private cache = new Map<string, { modules: PlatformModule[]; at: number }>();

  constructor(private store: EntitlementStore) {}

  /** The one function the guard layer depends on. */
  async modulesFor(companyId: string): Promise<PlatformModule[]> {
    const cached = this.cache.get(companyId);
    if (cached) return cached.modules;

    const plan = await this.store.planFor(companyId);
    if (!plan) return [];

    const base = new Set(modulesForPlan(plan));
    for (const o of await this.store.overridesFor(companyId)) {
      o.granted ? base.add(o.module) : base.delete(o.module);
    }

    const modules = [...base];
    this.cache.set(companyId, { modules, at: Date.now() });
    return modules;
  }

  async has(companyId: string, module: PlatformModule): Promise<boolean> {
    return (await this.modulesFor(companyId)).includes(module);
  }

  async applyPlan(companyId: string, plan: Plan): Promise<PlatformModule[]> {
    await this.store.setPlan(companyId, plan);
    this.invalidate(companyId);
    return this.modulesFor(companyId);
  }

  /**
   * Grant a module outside the plan. Refuses incoherent combinations —
   * THEFT_DETECTION without CUSTODY_TRACKING detects a fork it cannot
   * attribute, and shipping that would be selling a half-working feature.
   */
  async grant(input: {
    companyId: string; module: PlatformModule; setBy: string; reason?: string;
  }): Promise<{ modules: PlatformModule[] }> {
    const current = await this.modulesFor(input.companyId);
    const proposed = [...new Set([...current, input.module])];

    const problems = missingPrerequisites(proposed);
    const blocking = problems.find((p) => p.module === input.module);
    if (blocking) {
      throw new Error(
        `MODULE_PREREQUISITES_MISSING:${input.module} requires ${blocking.requires.join(", ")}`
      );
    }

    await this.store.putOverride({
      companyId: input.companyId,
      module: input.module,
      granted: true,
      reason: input.reason ?? null,
      setBy: input.setBy,
      setAt: Date.now(),
    });
    this.invalidate(input.companyId);
    return { modules: await this.modulesFor(input.companyId) };
  }

  /** Revoke, and refuse to leave dependents stranded. */
  async revoke(input: {
    companyId: string; module: PlatformModule; setBy: string; reason?: string;
  }): Promise<{ modules: PlatformModule[]; alsoDisabled: PlatformModule[] }> {
    const current = await this.modulesFor(input.companyId);
    const proposed = current.filter((m) => m !== input.module);

    // Anything that now lacks a prerequisite must go too — silently leaving it
    // enabled would mean a customer paying for a feature that cannot work.
    const orphaned = missingPrerequisites(proposed).map((p) => p.module);

    for (const m of [input.module, ...orphaned]) {
      await this.store.putOverride({
        companyId: input.companyId,
        module: m,
        granted: false,
        reason: m === input.module
          ? (input.reason ?? null)
          : `auto-disabled: depends on ${input.module}`,
        setBy: input.setBy,
        setAt: Date.now(),
      });
    }
    this.invalidate(input.companyId);
    return {
      modules: await this.modulesFor(input.companyId),
      alsoDisabled: orphaned,
    };
  }

  async clearOverride(companyId: string, module: PlatformModule): Promise<void> {
    await this.store.clearOverride(companyId, module);
    this.invalidate(companyId);
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }
}