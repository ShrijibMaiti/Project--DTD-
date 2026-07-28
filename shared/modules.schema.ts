
/**
 * THE commercial contract. Adding a sellable module means one entry here
 * plus one decorator on the routes — never a change to billing code.
 */

export enum PlatformModule {
  // Tier 1 — operations
  CORE = "CORE",                       // company, users, roles — always on
  FLEET = "FLEET",
  TRIPS = "TRIPS",
  GPS_TRACKING = "GPS_TRACKING",
  TRIP_HISTORY = "TRIP_HISTORY",
  REPORTS = "REPORTS",
  ANALYTICS = "ANALYTICS",
  DOCUMENTS = "DOCUMENTS",
  PAYMENTS = "PAYMENTS",
  SUPPORT = "SUPPORT",

  // Tier 2 — trust
  QR_GOODS = "QR_GOODS",
  GOODS_VERIFICATION = "GOODS_VERIFICATION",
  CUSTODY_TRACKING = "CUSTODY_TRACKING",
  THEFT_DETECTION = "THEFT_DETECTION",
  GPS_ANCHORING = "GPS_ANCHORING",
  REPUTATION = "REPUTATION",
  CLAIMS_EVIDENCE = "CLAIMS_EVIDENCE",
  FINANCING_RAILS = "FINANCING_RAILS",
}

export enum Plan {
  STARTER = "STARTER",
  STANDARD = "STANDARD",
  PROFESSIONAL = "PROFESSIONAL",
  ENTERPRISE = "ENTERPRISE",
}

const STARTER_MODULES = [
  PlatformModule.CORE,
  PlatformModule.FLEET,
  PlatformModule.TRIPS,
  PlatformModule.GPS_TRACKING,
  PlatformModule.SUPPORT,
];

const STANDARD_MODULES = [
  ...STARTER_MODULES,
  PlatformModule.TRIP_HISTORY,
  PlatformModule.REPORTS,
  PlatformModule.ANALYTICS,
  PlatformModule.DOCUMENTS,
  PlatformModule.PAYMENTS,
];

/**
 * Professional is the smallest COHERENT trust purchase: scanning without
 * custody signatures gives a count nobody is accountable for.
 */
const PROFESSIONAL_MODULES = [
  ...STANDARD_MODULES,
  PlatformModule.QR_GOODS,
  PlatformModule.GOODS_VERIFICATION,
  PlatformModule.CUSTODY_TRACKING,
];

const ENTERPRISE_MODULES = [
  ...PROFESSIONAL_MODULES,
  PlatformModule.THEFT_DETECTION,
  PlatformModule.GPS_ANCHORING,
  PlatformModule.REPUTATION,
  PlatformModule.CLAIMS_EVIDENCE,
  PlatformModule.FINANCING_RAILS,
];

export const PLAN_MODULES: Record<Plan, PlatformModule[]> = {
  [Plan.STARTER]: STARTER_MODULES,
  [Plan.STANDARD]: STANDARD_MODULES,
  [Plan.PROFESSIONAL]: PROFESSIONAL_MODULES,
  [Plan.ENTERPRISE]: ENTERPRISE_MODULES,
};

/** Monthly list price in paise (INR minor units). Overridable per contract. */
export const PLAN_PRICE_PAISE: Record<Plan, number> = {
  [Plan.STARTER]: 149_900,
  [Plan.STANDARD]: 399_900,
  [Plan.PROFESSIONAL]: 899_900,
  [Plan.ENTERPRISE]: 1_999_900,
};

/**
 * Interdependencies. THEFT_DETECTION without CUSTODY_TRACKING detects a
 * fork it cannot attribute — so we refuse to enable it alone.
 */
export const MODULE_REQUIRES: Partial<Record<PlatformModule, PlatformModule[]>> = {
  [PlatformModule.GOODS_VERIFICATION]: [PlatformModule.QR_GOODS],
  [PlatformModule.CUSTODY_TRACKING]: [PlatformModule.QR_GOODS],
  [PlatformModule.THEFT_DETECTION]: [
    PlatformModule.QR_GOODS,
    PlatformModule.CUSTODY_TRACKING,
  ],
  [PlatformModule.GPS_ANCHORING]: [PlatformModule.GPS_TRACKING],
  [PlatformModule.CLAIMS_EVIDENCE]: [
    PlatformModule.CUSTODY_TRACKING,
    PlatformModule.DOCUMENTS,
  ],
  [PlatformModule.FINANCING_RAILS]: [
    PlatformModule.DOCUMENTS,
    PlatformModule.CUSTODY_TRACKING,
  ],
  [PlatformModule.REPUTATION]: [PlatformModule.CUSTODY_TRACKING],
  [PlatformModule.ANALYTICS]: [PlatformModule.TRIP_HISTORY],
};

export function modulesForPlan(plan: Plan): PlatformModule[] {
  return PLAN_MODULES[plan] ?? [];
}

/** Returns missing prerequisites, or [] if the set is coherent. */
export function missingPrerequisites(
  enabled: PlatformModule[]
): Array<{ module: PlatformModule; requires: PlatformModule[] }> {
  const set = new Set(enabled);
  const problems: Array<{ module: PlatformModule; requires: PlatformModule[] }> = [];
  for (const m of enabled) {
    const needs = MODULE_REQUIRES[m] ?? [];
    const missing = needs.filter((n) => !set.has(n));
    if (missing.length) problems.push({ module: m, requires: missing });
  }
  return problems;
}


