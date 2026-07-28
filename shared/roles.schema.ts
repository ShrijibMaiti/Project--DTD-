/**
 * THE authorization contract. Every controller in every domain reads its
 * permissions from this one matrix, so "what can a Dispatcher do?" has
 * exactly one answer in the codebase, not nine.
 */

export enum Role {
  SUPER_ADMIN = "SUPER_ADMIN",
  COMPANY_ADMIN = "COMPANY_ADMIN",
  DISPATCHER = "DISPATCHER",
  DRIVER = "DRIVER",
  RECEIVER = "RECEIVER",
}

export enum Permission {
  // platform administration (SuperAdmin only)
  COMPANY_CREATE = "company:create",
  COMPANY_MANAGE_ALL = "company:manage_all",
  SUBSCRIPTION_MANAGE = "subscription:manage",
  MODULE_TOGGLE = "module:toggle",
  PLATFORM_ANALYTICS_VIEW = "platform:analytics",

  // company administration
  STAFF_INVITE = "staff:invite",
  STAFF_REMOVE = "staff:remove",
  FLEET_WRITE = "fleet:write",
  FLEET_READ = "fleet:read",
  COMPANY_SETTINGS = "company:settings",
  BILLING_VIEW = "billing:view",

  // operations
  TRIP_CREATE = "trip:create",
  TRIP_ASSIGN = "trip:assign",
  TRIP_CANCEL = "trip:cancel",
  TRIP_READ_ALL = "trip:read_all",
  TRIP_READ_OWN = "trip:read_own",
  TRACKING_VIEW = "tracking:view",
  REPORTS_VIEW = "reports:view",
  REPORTS_EXPORT = "reports:export",

  // driver surface
  TRIP_ACCEPT = "trip:accept",
  CUSTODY_SIGN = "custody:sign",
  DELIVERY_MARK = "delivery:mark",

  // receiver surface
  SCAN_SUBMIT = "scan:submit",
  DELIVERY_CONFIRM = "delivery:confirm",
  POD_SIGN = "pod:sign",
  SHORTAGE_REPORT = "shortage:report",

  // documents & money
  DOCUMENT_GENERATE = "document:generate",
  DOCUMENT_READ = "document:read",
  PAYMENT_COLLECT = "payment:collect",
  PAYMENT_READ = "payment:read",

  // trust tier
  MANIFEST_CREATE = "manifest:create",
  FORK_ALERTS_VIEW = "fork:alerts",
  CLAIMS_PACKET_BUILD = "claims:build",
  REPUTATION_VIEW = "reputation:view",
}

/** The matrix. Additive only — never grant by omission. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.SUPER_ADMIN]: [
    Permission.COMPANY_CREATE,
    Permission.COMPANY_MANAGE_ALL,
    Permission.SUBSCRIPTION_MANAGE,
    Permission.MODULE_TOGGLE,
    Permission.PLATFORM_ANALYTICS_VIEW,
    Permission.BILLING_VIEW,
  ],

  [Role.COMPANY_ADMIN]: [
    Permission.STAFF_INVITE,
    Permission.STAFF_REMOVE,
    Permission.FLEET_WRITE,
    Permission.FLEET_READ,
    Permission.COMPANY_SETTINGS,
    Permission.BILLING_VIEW,
    Permission.TRIP_CREATE,
    Permission.TRIP_ASSIGN,
    Permission.TRIP_CANCEL,
    Permission.TRIP_READ_ALL,
    Permission.TRACKING_VIEW,
    Permission.REPORTS_VIEW,
    Permission.REPORTS_EXPORT,
    Permission.DOCUMENT_GENERATE,
    Permission.DOCUMENT_READ,
    Permission.PAYMENT_COLLECT,
    Permission.PAYMENT_READ,
    Permission.MANIFEST_CREATE,
    Permission.FORK_ALERTS_VIEW,
    Permission.CLAIMS_PACKET_BUILD,
    Permission.REPUTATION_VIEW,
  ],

  [Role.DISPATCHER]: [
    Permission.FLEET_READ,
    Permission.TRIP_CREATE,
    Permission.TRIP_ASSIGN,
    Permission.TRIP_CANCEL,
    Permission.TRIP_READ_ALL,
    Permission.TRACKING_VIEW,
    Permission.REPORTS_VIEW,
    Permission.DOCUMENT_GENERATE,
    Permission.DOCUMENT_READ,
    Permission.MANIFEST_CREATE,
    // deliberately NOT: fleet:write, staff:*, billing, payment:collect
  ],

  [Role.DRIVER]: [
    Permission.TRIP_ACCEPT,
    Permission.TRIP_READ_OWN,
    Permission.CUSTODY_SIGN,
    Permission.DELIVERY_MARK,
    Permission.DOCUMENT_READ,
    // deliberately NOT: trip:read_all — a driver sees only his own trips
  ],

  [Role.RECEIVER]: [
    Permission.SCAN_SUBMIT,
    Permission.DELIVERY_CONFIRM,
    Permission.POD_SIGN,
    Permission.SHORTAGE_REPORT,
  ],
};

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Roles that may act across company boundaries. Exactly one. */
export const CROSS_TENANT_ROLES: Role[] = [Role.SUPER_ADMIN];