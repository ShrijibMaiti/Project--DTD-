/**
 * identity/subscriptions/plans.ts
 * Plan definitions, upgrade/downgrade paths, and proration.
 * Reads the module map from shared/modules.schema.ts — never redefines it.
 */

import {
  Plan, PlatformModule, PLAN_MODULES, PLAN_PRICE_PAISE, modulesForPlan,
} from "@dtd/shared/modules.schema";

export interface PlanDescriptor {
  plan: Plan;
  displayName: string;
  monthlyPaise: number;
  modules: PlatformModule[];
  pitch: string;
}

const PITCH: Record<Plan, string> = {
  [Plan.STARTER]: "Your fleet and trips in one place, with live tracking.",
  [Plan.STANDARD]: "Everything on record — history, reports, and paperwork your accountant accepts.",
  [Plan.PROFESSIONAL]: "Know what was loaded and what arrived, the same day.",
  [Plan.ENTERPRISE]: "Proof nobody can argue with — theft attribution, claims, and credit.",
};

const ORDER: Plan[] = [Plan.STARTER, Plan.STANDARD, Plan.PROFESSIONAL, Plan.ENTERPRISE];

export function describe(plan: Plan): PlanDescriptor {
  return {
    plan,
    displayName: plan.charAt(0) + plan.slice(1).toLowerCase(),
    monthlyPaise: PLAN_PRICE_PAISE[plan],
    modules: modulesForPlan(plan),
    pitch: PITCH[plan],
  };
}

export function allPlans(): PlanDescriptor[] {
  return ORDER.map(describe);
}

export function rank(plan: Plan): number {
  return ORDER.indexOf(plan);
}

export function isUpgrade(from: Plan, to: Plan): boolean {
  return rank(to) > rank(from);
}

/** What a customer gains or loses by switching — for the confirmation screen. */
export function planDelta(from: Plan, to: Plan): {
  gained: PlatformModule[];
  lost: PlatformModule[];
  direction: "UPGRADE" | "DOWNGRADE" | "SAME";
} {
  const before = new Set(PLAN_MODULES[from]);
  const after = new Set(PLAN_MODULES[to]);
  return {
    gained: [...after].filter((m) => !before.has(m)),
    lost: [...before].filter((m) => !after.has(m)),
    direction: rank(to) > rank(from) ? "UPGRADE"
      : rank(to) < rank(from) ? "DOWNGRADE" : "SAME",
  };
}

/**
 * Proration in paise. Upgrades charge the difference for the remaining days;
 * downgrades never refund cash — they credit the next cycle, which is both
 * standard SaaS practice and much simpler to reconcile.
 */
export function prorate(input: {
  from: Plan; to: Plan; daysRemaining: number; daysInCycle: number;
}): { chargePaise: number; creditPaise: number } {
  const fraction = Math.max(0, Math.min(1, input.daysRemaining / input.daysInCycle));
  const diff = PLAN_PRICE_PAISE[input.to] - PLAN_PRICE_PAISE[input.from];
  const amount = Math.round(Math.abs(diff) * fraction);
  return diff > 0
    ? { chargePaise: amount, creditPaise: 0 }
    : { chargePaise: 0, creditPaise: amount };
}