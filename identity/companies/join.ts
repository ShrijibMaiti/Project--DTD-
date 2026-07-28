/**
 * identity/companies/join.ts
 * Driver joins via Company ID or invite token.
 *
 * The Company-ID path exists because a fleet onboarding 40 drivers cannot send
 * 40 individual links. But it must NOT become a self-signup backdoor — so a
 * Company-ID join creates a JOIN REQUEST that an admin approves, never a live
 * user. The only path that creates a user directly is an invite the admin
 * personally issued.
 */

import { randomUUID } from "crypto";
import { Role } from "@dtd/shared/roles.schema";
import type { CompanyStore } from "./registration";
import type { InvitationService, UserCreator } from "./invitations";

export type JoinRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface JoinRequest {
  id: string;
  companyId: string;
  fullName: string;
  phone: string;
  requestedRole: Role;
  status: JoinRequestStatus;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface JoinRequestStore {
  create(r: JoinRequest): Promise<void>;
  byId(id: string): Promise<JoinRequest | null>;
  pendingFor(companyId: string): Promise<JoinRequest[]>;
  decide(id: string, status: JoinRequestStatus, by: string): Promise<void>;
  existingPending(companyId: string, phone: string): Promise<JoinRequest | null>;
}

/** Roles a stranger may request. Only the lowest-privilege ones. */
const SELF_REQUESTABLE: Role[] = [Role.DRIVER, Role.RECEIVER];

export class JoinService {
  constructor(
    private requests: JoinRequestStore,
    private companies: CompanyStore,
    private users: UserCreator,
    private invitations: InvitationService
  ) {}

  /** Path A — invite token. Creates the user immediately; admin already vouched. */
  async joinByInvite(token: string) {
    return this.invitations.accept(token);
  }

  /**
   * Path B — Company ID. Creates a REQUEST, not a user. The company code is
   * shareable and therefore not a credential; treating it as one would let
   * anyone who saw a truck's paperwork join the fleet.
   */
  async requestJoin(input: {
    companyCode: string;
    fullName: string;
    phone: string;
    requestedRole: Role;
  }): Promise<{ requestId: string; status: JoinRequestStatus; companyName: string }> {
    if (!SELF_REQUESTABLE.includes(input.requestedRole)) {
      throw new Error(`ROLE_NOT_SELF_REQUESTABLE:${input.requestedRole}`);
    }

    const company = await this.companies.byCode(input.companyCode.trim().toUpperCase());
    if (!company) throw new Error("INVALID_COMPANY_CODE");
    if (company.status !== "ACTIVE") throw new Error("COMPANY_NOT_ACTIVE");

    if (await this.users.existsByContact(input.phone, null)) {
      throw new Error("USER_ALREADY_EXISTS");
    }
    if (await this.requests.existingPending(company.id, input.phone)) {
      throw new Error("REQUEST_ALREADY_PENDING");
    }

    const request: JoinRequest = {
      id: randomUUID(),
      companyId: company.id,
      fullName: input.fullName,
      phone: input.phone,
      requestedRole: input.requestedRole,
      status: "PENDING",
      createdAt: Date.now(),
      decidedBy: null,
      decidedAt: null,
    };
    await this.requests.create(request);

    return {
      requestId: request.id,
      status: "PENDING",
      companyName: company.legalName,
    };
  }

  /** Admin approval is the moment a user actually comes into existence. */
  async approve(
    companyId: string, requestId: string, approvedBy: string, roleOverride?: Role
  ): Promise<{ userId: string; role: Role }> {
    const request = await this.requests.byId(requestId);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (request.companyId !== companyId) throw new Error("WRONG_COMPANY");
    if (request.status !== "PENDING") throw new Error("NOT_PENDING");

    const role = roleOverride ?? request.requestedRole;
    if (!SELF_REQUESTABLE.includes(role) && role !== Role.DISPATCHER) {
      throw new Error("CANNOT_GRANT_THIS_ROLE_VIA_JOIN");
    }

    const { userId } = await this.users.create({
      companyId,
      role,
      fullName: request.fullName,
      phone: request.phone,
      email: null,
    });

    await this.requests.decide(requestId, "APPROVED", approvedBy);
    return { userId, role };
  }

  async reject(companyId: string, requestId: string, by: string): Promise<void> {
    const request = await this.requests.byId(requestId);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (request.companyId !== companyId) throw new Error("WRONG_COMPANY");
    await this.requests.decide(requestId, "REJECTED", by);
  }

  listPending(companyId: string) {
    return this.requests.pendingFor(companyId);
  }
}