/**
 * identity/tests/invitations.e2e.test.ts
 * No self-signup path creates an orphan company.
 *
 * The invariant under test: every user's companyId was chosen by an authorised
 * human, never supplied by the person signing up.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Role } from "@dtd/shared/roles.schema";
import { Plan } from "@dtd/shared/modules.schema";
import {
  InvitationService, INVITABLE_ROLES, type Invitation, type InvitationStore,
} from "../companies/invitations";
import { JoinService, type JoinRequest, type JoinRequestStore } from "../companies/join";
import { RegistrationService, generateCompanyCode, type Company, type CompanyStore } from "../companies/registration";

process.env.DTD_INVITE_SECRET = "test-invite-secret";
process.env.APP_BASE_URL = "https://app.test";

const COMPANY_A = "company-A";

class InMemoryInviteStore implements InvitationStore {
  rows = new Map<string, Invitation>();
  async create(i: Invitation) { this.rows.set(i.id, i); }
  async byId(id: string) { return this.rows.get(id) ?? null; }
  async pendingFor(companyId: string) {
    return [...this.rows.values()].filter(
      (i) => i.companyId === companyId && i.status === "PENDING"
    );
  }
  async markAccepted(id: string, userId: string) {
    const i = this.rows.get(id)!;
    this.rows.set(id, { ...i, status: "ACCEPTED", acceptedUserId: userId });
  }
  async markRevoked(id: string) {
    const i = this.rows.get(id)!;
    this.rows.set(id, { ...i, status: "REVOKED" });
  }
  async existingPending(companyId: string, contact: string) {
    return [...this.rows.values()].find(
      (i) => i.companyId === companyId && i.status === "PENDING" &&
        (i.phone === contact || i.email === contact)
    ) ?? null;
  }
}

class InMemoryJoinStore implements JoinRequestStore {
  rows = new Map<string, JoinRequest>();
  async create(r: JoinRequest) { this.rows.set(r.id, r); }
  async byId(id: string) { return this.rows.get(id) ?? null; }
  async pendingFor(companyId: string) {
    return [...this.rows.values()].filter(
      (r) => r.companyId === companyId && r.status === "PENDING"
    );
  }
  async decide(id: string, status: any, by: string) {
    const r = this.rows.get(id)!;
    this.rows.set(id, { ...r, status, decidedBy: by, decidedAt: Date.now() });
  }
  async existingPending(companyId: string, phone: string) {
    return [...this.rows.values()].find(
      (r) => r.companyId === companyId && r.phone === phone && r.status === "PENDING"
    ) ?? null;
  }
}

class InMemoryCompanyStore implements CompanyStore {
  rows = new Map<string, Company>();
  async create(c: Company) { this.rows.set(c.id, c); }
  async byId(id: string) { return this.rows.get(id) ?? null; }
  async byCode(code: string) {
    return [...this.rows.values()].find((c) => c.companyCode === code) ?? null;
  }
  async byGstin(gstin: string) {
    return [...this.rows.values()].find((c) => c.gstin === gstin) ?? null;
  }
  async setStatus(id: string, status: any, approvedBy?: string) {
    const c = this.rows.get(id)!;
    this.rows.set(id, { ...c, status, approvedBy: approvedBy ?? c.approvedBy });
  }
  async setPlan(id: string, plan: Plan) {
    const c = this.rows.get(id)!;
    this.rows.set(id, { ...c, plan });
  }
  async listPending() {
    return [...this.rows.values()].filter((c) => c.status === "PENDING");
  }
}

function makeUsers() {
  const created: any[] = [];
  return {
    created,
    create: vi.fn(async (input: any) => {
      created.push(input);
      return { userId: `user-${created.length}` };
    }),
    existsByContact: vi.fn(async () => false),
  };
}

function makeNotifier() {
  return { sendWhatsApp: vi.fn(async () => {}), sendEmail: vi.fn(async () => {}) };
}

describe("InvitationService", () => {
  let invites: InMemoryInviteStore;
  let users: ReturnType<typeof makeUsers>;
  let notifier: ReturnType<typeof makeNotifier>;
  let svc: InvitationService;

  beforeEach(() => {
    invites = new InMemoryInviteStore();
    users = makeUsers();
    notifier = makeNotifier();
    svc = new InvitationService(invites, users as any, notifier as any);
  });

  it("invites a driver and sends a WhatsApp link", async () => {
    const r = await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh Kumar", phone: "+919000000001",
    });
    expect(r.url).toContain("/join/");
    expect(notifier.sendWhatsApp).toHaveBeenCalled();
  });

  it("NOBODY can be invited as SUPER_ADMIN", async () => {
    await expect(svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.SUPER_ADMIN,
      fullName: "Attacker", phone: "+919000000002",
    })).rejects.toThrow("ROLE_NOT_INVITABLE");
    expect(INVITABLE_ROLES).not.toContain(Role.SUPER_ADMIN);
  });

  it("THE CORE INVARIANT: accepting binds the user to the INVITING company", async () => {
    const r = await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    });
    const token = r.url.split("/join/")[1];
    const accepted = await svc.accept(token);

    expect(accepted.companyId).toBe(COMPANY_A);
    // The created user's companyId came from the invite, never from input.
    expect(users.created[0].companyId).toBe(COMPANY_A);
    expect(users.created[0].role).toBe(Role.DRIVER);
  });

  it("a tampered token is rejected", async () => {
    const r = await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    });
    const token = r.url.split("/join/")[1];
    const [payload] = token.split(".");
    const forged = Buffer.from(JSON.stringify({
      i: "some-other-invite", e: Date.now() + 100000,
    })).toString("base64url");

    await expect(svc.accept(`${forged}.${token.split(".")[1]}`))
      .rejects.toThrow("BAD_INVITE_SIGNATURE");
  });

  it("an invite cannot be used twice", async () => {
    const r = await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    });
    const token = r.url.split("/join/")[1];
    await svc.accept(token);
    await expect(svc.accept(token)).rejects.toThrow("INVITE_ALREADY_USED");
  });

  it("a revoked invite cannot be accepted", async () => {
    const r = await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    });
    await svc.revoke(COMPANY_A, r.inviteId);
    const token = r.url.split("/join/")[1];
    await expect(svc.accept(token)).rejects.toThrow("INVITE_REVOKED");
  });

  it("another company cannot revoke this company's invite", async () => {
    const r = await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    });
    await expect(svc.revoke("company-B", r.inviteId)).rejects.toThrow("WRONG_COMPANY");
  });

  it("rejects duplicate pending invites for the same contact", async () => {
    await svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    });
    await expect(svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DISPATCHER,
      fullName: "Ramesh again", phone: "+919000000001",
    })).rejects.toThrow("INVITE_ALREADY_PENDING");
  });

  it("rejects inviting someone who already has an account", async () => {
    users.existsByContact = vi.fn(async () => true);
    await expect(svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Ramesh", phone: "+919000000001",
    })).rejects.toThrow("USER_ALREADY_EXISTS");
  });

  it("requires a phone or an email", async () => {
    await expect(svc.invite({
      companyId: COMPANY_A, invitedBy: "admin1", role: Role.DRIVER,
      fullName: "Nobody",
    })).rejects.toThrow("NEED_PHONE_OR_EMAIL");
  });
});

describe("JoinService — the Company-ID path is NOT a signup backdoor", () => {
  let requests: InMemoryJoinStore;
  let companies: InMemoryCompanyStore;
  let users: ReturnType<typeof makeUsers>;
  let invitations: InvitationService;
  let svc: JoinService;
  let code: string;

  beforeEach(async () => {
    requests = new InMemoryJoinStore();
    companies = new InMemoryCompanyStore();
    users = makeUsers();
    invitations = new InvitationService(
      new InMemoryInviteStore(), users as any, makeNotifier() as any
    );
    svc = new JoinService(requests, companies, users as any, invitations);

    code = generateCompanyCode();
    await companies.create({
      id: COMPANY_A, companyCode: code, legalName: "Sharma Logistics",
      gstin: null, contactPhone: "+919000000000", contactEmail: "a@b.com",
      status: "ACTIVE", plan: Plan.STANDARD,
      createdAt: new Date().toISOString(), approvedBy: "sa",
    });
  });

  it("THE CORE INVARIANT: a company code creates a REQUEST, never a user", async () => {
    const r = await svc.requestJoin({
      companyCode: code, fullName: "Ramesh",
      phone: "+919000000001", requestedRole: Role.DRIVER,
    });
    expect(r.status).toBe("PENDING");
    expect(users.create).not.toHaveBeenCalled(); // no user exists yet
  });

  it("a user comes into existence only when an admin approves", async () => {
    const r = await svc.requestJoin({
      companyCode: code, fullName: "Ramesh",
      phone: "+919000000001", requestedRole: Role.DRIVER,
    });
    const approved = await svc.approve(COMPANY_A, r.requestId, "admin1");

    expect(users.create).toHaveBeenCalled();
    expect(users.created[0].companyId).toBe(COMPANY_A);
    expect(approved.role).toBe(Role.DRIVER);
  });

  it("ESCALATION: nobody can self-request COMPANY_ADMIN", async () => {
    await expect(svc.requestJoin({
      companyCode: code, fullName: "Attacker",
      phone: "+919000000002", requestedRole: Role.COMPANY_ADMIN,
    })).rejects.toThrow("ROLE_NOT_SELF_REQUESTABLE");
  });

  it("ESCALATION: nobody can self-request SUPER_ADMIN", async () => {
    await expect(svc.requestJoin({
      companyCode: code, fullName: "Attacker",
      phone: "+919000000003", requestedRole: Role.SUPER_ADMIN,
    })).rejects.toThrow("ROLE_NOT_SELF_REQUESTABLE");
  });

  it("approval cannot mint a COMPANY_ADMIN through the join path", async () => {
    const r = await svc.requestJoin({
      companyCode: code, fullName: "Ramesh",
      phone: "+919000000001", requestedRole: Role.DRIVER,
    });
    await expect(
      svc.approve(COMPANY_A, r.requestId, "admin1", Role.COMPANY_ADMIN)
    ).rejects.toThrow("CANNOT_GRANT_THIS_ROLE_VIA_JOIN");
  });

  it("an invalid company code is rejected", async () => {
    await expect(svc.requestJoin({
      companyCode: "DTD-XXXXXX", fullName: "Nobody",
      phone: "+919000000009", requestedRole: Role.DRIVER,
    })).rejects.toThrow("INVALID_COMPANY_CODE");
  });

  it("a suspended company accepts no joins", async () => {
    await companies.setStatus(COMPANY_A, "SUSPENDED");
    await expect(svc.requestJoin({
      companyCode: code, fullName: "Ramesh",
      phone: "+919000000001", requestedRole: Role.DRIVER,
    })).rejects.toThrow("COMPANY_NOT_ACTIVE");
  });

  it("CROSS-TENANT: another company cannot approve this company's request", async () => {
    const r = await svc.requestJoin({
      companyCode: code, fullName: "Ramesh",
      phone: "+919000000001", requestedRole: Role.DRIVER,
    });
    await expect(svc.approve("company-B", r.requestId, "admin-b"))
      .rejects.toThrow("WRONG_COMPANY");
  });

  it("rejected requests create no user", async () => {
    const r = await svc.requestJoin({
      companyCode: code, fullName: "Ramesh",
      phone: "+919000000001", requestedRole: Role.DRIVER,
    });
    await svc.reject(COMPANY_A, r.requestId, "admin1");
    expect(users.create).not.toHaveBeenCalled();
  });
});

describe("RegistrationService", () => {
  let companies: InMemoryCompanyStore;
  let admins: any;
  let entitlements: any;
  let svc: RegistrationService;

  beforeEach(() => {
    companies = new InMemoryCompanyStore();
    admins = {
      createCompanyAdmin: vi.fn(async () => ({
        userId: "admin-1", setupToken: "setup-token",
      })),
    };
    entitlements = { applyPlan: vi.fn(async () => {}) };
    svc = new RegistrationService(companies, admins, entitlements);
  });

  it("SuperAdmin provisioning creates an ACTIVE company with its admin", async () => {
    const r = await svc.provision({
      legalName: "Sharma Logistics", contactPhone: "+919000000000",
      contactEmail: "owner@sharma.in", plan: Plan.STANDARD,
      adminFullName: "Sharma", provisionedBy: "sa",
    });
    expect(r.company.status).toBe("ACTIVE");
    expect(r.company.companyCode).toMatch(/^DTD-[0-9A-HJ-NP-TV-Z]{6}$/);
    expect(entitlements.applyPlan).toHaveBeenCalledWith(r.company.id, Plan.STANDARD);
  });

  it("THE CORE INVARIANT: a public application creates NO user and NO entitlements", async () => {
    const r = await svc.apply({
      legalName: "Unknown Transport", contactPhone: "+919000000005",
      contactEmail: "x@y.com",
    });
    expect(r.status).toBe("PENDING");
    expect(admins.createCompanyAdmin).not.toHaveBeenCalled();
    expect(entitlements.applyPlan).not.toHaveBeenCalled();
  });

  it("approval is what turns an application into a working company", async () => {
    const app = await svc.apply({
      legalName: "Unknown Transport", contactPhone: "+919000000005",
      contactEmail: "x@y.com",
    });
    await svc.approve(app.applicationId, "sa", Plan.STARTER, "Owner");

    expect(admins.createCompanyAdmin).toHaveBeenCalled();
    expect(entitlements.applyPlan).toHaveBeenCalledWith(app.applicationId, Plan.STARTER);
  });

  it("rejects a duplicate GSTIN", async () => {
    await svc.provision({
      legalName: "A", gstin: "27AAAAA0000A1Z5", contactPhone: "+91900000001",
      contactEmail: "a@a.com", plan: Plan.STARTER,
      adminFullName: "A", provisionedBy: "sa",
    });
    await expect(svc.provision({
      legalName: "B", gstin: "27AAAAA0000A1Z5", contactPhone: "+91900000002",
      contactEmail: "b@b.com", plan: Plan.STARTER,
      adminFullName: "B", provisionedBy: "sa",
    })).rejects.toThrow("GSTIN_ALREADY_REGISTERED");
  });

  it("company codes avoid ambiguous characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCompanyCode()).not.toMatch(/[ILOU]/);
    }
  });
});