/**
 * identity/companies/registration.ts
 * A company registers ONCE and receives a Company ID. There is deliberately
 * no self-service path that creates a company plus its first admin in one
 * anonymous request — that is how orphan companies and squatted names happen.
 *
 * Two legitimate paths:
 *   1. SuperAdmin provisions the company (sales-led; the default).
 *   2. Public application → pending review → SuperAdmin approves.
 */

import { randomUUID, randomBytes } from "crypto";
import { Plan } from "@dtd/shared/modules.schema";
import { Role } from "@dtd/shared/roles.schema";

export type CompanyStatus = "PENDING" | "ACTIVE" | "SUSPENDED";

export interface Company {
  id: string;
  companyCode: string;     // human-shareable: "DTD-7K2M9Q"
  legalName: string;
  gstin: string | null;
  contactPhone: string;
  contactEmail: string;
  status: CompanyStatus;
  plan: Plan;
  createdAt: string;
  approvedBy: string | null;
}

export interface CompanyStore {
  create(c: Company): Promise<void>;
  byId(id: string): Promise<Company | null>;
  byCode(code: string): Promise<Company | null>;
  byGstin(gstin: string): Promise<Company | null>;
  setStatus(id: string, status: CompanyStatus, approvedBy?: string): Promise<void>;
  setPlan(id: string, plan: Plan): Promise<void>;
  listPending(): Promise<Company[]>;
}

export interface AdminUserCreator {
  createCompanyAdmin(input: {
    companyId: string; fullName: string; email: string; phone: string;
  }): Promise<{ userId: string; setupToken: string }>;
}

export interface EntitlementWriter {
  applyPlan(companyId: string, plan: Plan): Promise<void>;
}

export function generateCompanyCode(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I L O U
  const b = randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return `DTD-${s}`;
}

export class RegistrationService {
  constructor(
    private companies: CompanyStore,
    private admins: AdminUserCreator,
    private entitlements: EntitlementWriter
  ) {}

  /** Path 1 — SuperAdmin provisions. Company is ACTIVE immediately. */
  async provision(input: {
    legalName: string;
    gstin?: string;
    contactPhone: string;
    contactEmail: string;
    plan: Plan;
    adminFullName: string;
    provisionedBy: string; // SuperAdmin userId
  }): Promise<{ company: Company; adminUserId: string; setupToken: string }> {
    await this.assertUniqueGstin(input.gstin);

    const company: Company = {
      id: randomUUID(),
      companyCode: generateCompanyCode(),
      legalName: input.legalName,
      gstin: input.gstin ?? null,
      contactPhone: input.contactPhone,
      contactEmail: input.contactEmail.toLowerCase(),
      status: "ACTIVE",
      plan: input.plan,
      createdAt: new Date().toISOString(),
      approvedBy: input.provisionedBy,
    };
    await this.companies.create(company);
    await this.entitlements.applyPlan(company.id, input.plan);

    const admin = await this.admins.createCompanyAdmin({
      companyId: company.id,
      fullName: input.adminFullName,
      email: input.contactEmail.toLowerCase(),
      phone: input.contactPhone,
    });

    return { company, adminUserId: admin.userId, setupToken: admin.setupToken };
  }

  /** Path 2 — public application. Creates NO users and NO entitlements yet. */
  async apply(input: {
    legalName: string;
    gstin?: string;
    contactPhone: string;
    contactEmail: string;
  }): Promise<{ applicationId: string; status: CompanyStatus }> {
    await this.assertUniqueGstin(input.gstin);

    const company: Company = {
      id: randomUUID(),
      companyCode: generateCompanyCode(),
      legalName: input.legalName,
      gstin: input.gstin ?? null,
      contactPhone: input.contactPhone,
      contactEmail: input.contactEmail.toLowerCase(),
      status: "PENDING",
      plan: Plan.STARTER,
      createdAt: new Date().toISOString(),
      approvedBy: null,
    };
    await this.companies.create(company);
    return { applicationId: company.id, status: "PENDING" };
  }

  async approve(
    companyId: string, superAdminId: string, plan: Plan, adminFullName: string
  ) {
    const company = await this.companies.byId(companyId);
    if (!company) throw new Error("COMPANY_NOT_FOUND");
    if (company.status !== "PENDING") throw new Error("NOT_PENDING");

    await this.companies.setStatus(companyId, "ACTIVE", superAdminId);
    await this.companies.setPlan(companyId, plan);
    await this.entitlements.applyPlan(companyId, plan);

    const admin = await this.admins.createCompanyAdmin({
      companyId,
      fullName: adminFullName,
      email: company.contactEmail,
      phone: company.contactPhone,
    });

    return { companyId, adminUserId: admin.userId, setupToken: admin.setupToken };
  }

  async suspend(companyId: string, superAdminId: string): Promise<void> {
    await this.companies.setStatus(companyId, "SUSPENDED", superAdminId);
  }

  byCode(code: string) {
    return this.companies.byCode(code.trim().toUpperCase());
  }

  private async assertUniqueGstin(gstin?: string) {
    if (!gstin) return;
    const existing = await this.companies.byGstin(gstin);
    if (existing) throw new Error("GSTIN_ALREADY_REGISTERED");
  }
}