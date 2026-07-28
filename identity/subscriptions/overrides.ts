/**
 * identity/subscriptions/overrides.ts
 * SuperAdmin toggles one module for one customer — pilots, trials, goodwill
 * credits, and staged rollouts.
 *
 * Every override is audit-logged with a reason and an optional expiry, because
 * "why does this customer have Enterprise features on a Standard plan?" must
 * always have an answer.
 */

import { PlatformModule } from "@dtd/shared/modules.schema";
import { Role } from "@dtd/shared/roles.schema";
import type { EntitlementService } from "./entitlements";

export interface OverrideRecord {
  id: string;
  companyId: string;
  module: PlatformModule;
  granted: boolean;
  reason: string;
  setBy: string;
  setAt: number;
  expiresAt: number | null;
}

export interface OverrideStore {
  record(o: OverrideRecord): Promise<void>;
  listForCompany(companyId: string): Promise<OverrideRecord[]>;
  listExpired(now: number): Promise<OverrideRecord[]>;
  markExpired(id: string): Promise<void>;
}

export interface OverrideAudit {
  record(e: {
    actorId: string; companyId: string; module: PlatformModule;
    action: "GRANT" | "REVOKE" | "EXPIRE"; reason: string; at: number;
  }): Promise<void>;
}

export class OverrideService {
  constructor(
    private overrides: OverrideStore,
    private entitlements: EntitlementService,
    private audit: OverrideAudit
  ) {}

  private assertSuperAdmin(role: Role) {
    if (role !== Role.SUPER_ADMIN) throw new Error("SUPER_ADMIN_ONLY");
  }

  /** Trial grant: enable a module for N days, then auto-revoke. */
  async grant(input: {
    actorId: string;
    actorRole: Role;
    companyId: string;
    module: PlatformModule;
    reason: string;
    trialDays?: number;
  }): Promise<{ modules: PlatformModule[]; expiresAt: number | null }> {
    this.assertSuperAdmin(input.actorRole);
    if (!input.reason?.trim()) throw new Error("REASON_REQUIRED");

    // Throws if prerequisites are missing — see entitlements.grant().
    const { modules } = await this.entitlements.grant({
      companyId: input.companyId,
      module: input.module,
      setBy: input.actorId,
      reason: input.reason,
    });

    const expiresAt = input.trialDays
      ? Date.now() + input.trialDays * 86400_000
      : null;

    await this.overrides.record({
      id: crypto.randomUUID(),
      companyId: input.companyId,
      module: input.module,
      granted: true,
      reason: input.reason,
      setBy: input.actorId,
      setAt: Date.now(),
      expiresAt,
    });
    await this.audit.record({
      actorId: input.actorId, companyId: input.companyId, module: input.module,
      action: "GRANT", reason: input.reason, at: Date.now(),
    });

    return { modules, expiresAt };
  }

  async revoke(input: {
    actorId: string;
    actorRole: Role;
    companyId: string;
    module: PlatformModule;
    reason: string;
  }): Promise<{ modules: PlatformModule[]; alsoDisabled: PlatformModule[] }> {
    this.assertSuperAdmin(input.actorRole);
    if (!input.reason?.trim()) throw new Error("REASON_REQUIRED");

    const result = await this.entitlements.revoke({
      companyId: input.companyId,
      module: input.module,
      setBy: input.actorId,
      reason: input.reason,
    });

    await this.overrides.record({
      id: crypto.randomUUID(),
      companyId: input.companyId,
      module: input.module,
      granted: false,
      reason: input.reason,
      setBy: input.actorId,
      setAt: Date.now(),
      expiresAt: null,
    });
    await this.audit.record({
      actorId: input.actorId, companyId: input.companyId, module: input.module,
      action: "REVOKE", reason: input.reason, at: Date.now(),
    });

    return result;
  }

  /** Daily job — trials end on their own, without anyone remembering. */
  async expireTrials(now = Date.now()): Promise<OverrideRecord[]> {
    const expired = await this.overrides.listExpired(now);
    for (const o of expired) {
      await this.entitlements.clearOverride(o.companyId, o.module);
      await this.overrides.markExpired(o.id);
      await this.audit.record({
        actorId: "system", companyId: o.companyId, module: o.module,
        action: "EXPIRE", reason: `trial ended (granted: ${o.reason})`, at: now,
      });
    }
    return expired;
  }

  /** "Why does this customer have X?" — the answer, always. */
  explain(companyId: string) {
    return this.overrides.listForCompany(companyId);
  }
}