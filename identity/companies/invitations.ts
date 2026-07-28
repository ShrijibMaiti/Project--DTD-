/**
 * identity/companies/invitations.ts
 * Admins invite staff by WhatsApp/email link. Nobody self-creates a company,
 * and nobody joins a company they weren't invited to.
 *
 * The invariant this file exists to hold: every user in the system has a
 * companyId that an authorised human chose for them.
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { Role } from "@dtd/shared/roles.schema";

export type InviteStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export interface Invitation {
  id: string;
  companyId: string;
  role: Role;
  fullName: string;
  phone: string | null;
  email: string | null;
  invitedBy: string;
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
  acceptedUserId: string | null;
}

export interface InvitationStore {
  create(i: Invitation): Promise<void>;
  byId(id: string): Promise<Invitation | null>;
  pendingFor(companyId: string): Promise<Invitation[]>;
  markAccepted(id: string, userId: string): Promise<void>;
  markRevoked(id: string): Promise<void>;
  existingPending(companyId: string, contact: string): Promise<Invitation | null>;
}

export interface UserCreator {
  create(input: {
    companyId: string; role: Role; fullName: string;
    phone: string | null; email: string | null;
  }): Promise<{ userId: string }>;
  existsByContact(phone: string | null, email: string | null): Promise<boolean>;
}

export interface InviteNotifier {
  sendWhatsApp(phone: string, message: string): Promise<void>;
  sendEmail(email: string, subject: string, body: string): Promise<void>;
}

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

/** Roles a Company Admin may invite. Notably NOT SuperAdmin. */
export const INVITABLE_ROLES: Role[] = [
  Role.COMPANY_ADMIN,
  Role.DISPATCHER,
  Role.DRIVER,
  Role.RECEIVER,
];

export class InvitationService {
  constructor(
    private invites: InvitationStore,
    private users: UserCreator,
    private notifier: InviteNotifier,
    private secret = process.env.DTD_INVITE_SECRET!,
    private baseUrl = process.env.APP_BASE_URL!
  ) {}

  async invite(input: {
    companyId: string;
    invitedBy: string;
    role: Role;
    fullName: string;
    phone?: string;
    email?: string;
  }): Promise<{ inviteId: string; url: string; expiresAt: number }> {
    if (!INVITABLE_ROLES.includes(input.role)) {
      throw new Error(`ROLE_NOT_INVITABLE:${input.role}`);
    }
    if (!input.phone && !input.email) {
      throw new Error("NEED_PHONE_OR_EMAIL");
    }
    if (await this.users.existsByContact(input.phone ?? null, input.email ?? null)) {
      throw new Error("USER_ALREADY_EXISTS");
    }
    const contact = input.phone ?? input.email!;
    if (await this.invites.existingPending(input.companyId, contact)) {
      throw new Error("INVITE_ALREADY_PENDING");
    }

    const invitation: Invitation = {
      id: randomUUID(),
      companyId: input.companyId,
      role: input.role,
      fullName: input.fullName,
      phone: input.phone ?? null,
      email: input.email?.toLowerCase() ?? null,
      invitedBy: input.invitedBy,
      status: "PENDING",
      createdAt: Date.now(),
      expiresAt: Date.now() + INVITE_TTL_MS,
      acceptedUserId: null,
    };
    await this.invites.create(invitation);

    const token = this.encode(invitation.id, invitation.expiresAt);
    const url = `${this.baseUrl}/join/${token}`;

    const message =
      `You've been added as ${humanRole(input.role)}. ` +
      `Tap to set up your DTD account (link valid 7 days):\n${url}`;

    if (invitation.phone) await this.notifier.sendWhatsApp(invitation.phone, message);
    else if (invitation.email) {
      await this.notifier.sendEmail(invitation.email, "Your DTD account", message);
    }

    return { inviteId: invitation.id, url, expiresAt: invitation.expiresAt };
  }

  /** Read-only preview shown before the invitee commits. */
  async preview(token: string) {
    const invitation = await this.resolve(token);
    return {
      fullName: invitation.fullName,
      role: invitation.role,
      companyId: invitation.companyId,
      expiresAt: invitation.expiresAt,
    };
  }

  /** Accept → creates the user, permanently bound to the inviting company. */
  async accept(token: string): Promise<{ userId: string; companyId: string; role: Role }> {
    const invitation = await this.resolve(token);

    const { userId } = await this.users.create({
      companyId: invitation.companyId,   // NOT caller-supplied — this is the point
      role: invitation.role,
      fullName: invitation.fullName,
      phone: invitation.phone,
      email: invitation.email,
    });

    await this.invites.markAccepted(invitation.id, userId);
    return { userId, companyId: invitation.companyId, role: invitation.role };
  }

  async revoke(companyId: string, inviteId: string): Promise<void> {
    const invitation = await this.invites.byId(inviteId);
    if (!invitation) throw new Error("INVITE_NOT_FOUND");
    if (invitation.companyId !== companyId) throw new Error("WRONG_COMPANY");
    if (invitation.status !== "PENDING") throw new Error("NOT_PENDING");
    await this.invites.markRevoked(inviteId);
  }

  listPending(companyId: string) {
    return this.invites.pendingFor(companyId);
  }

  // ---------------------------------------------------------------- token

  private encode(inviteId: string, expiresAt: number): string {
    const payload = Buffer.from(JSON.stringify({ i: inviteId, e: expiresAt }))
      .toString("base64url");
    const sig = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  private async resolve(token: string): Promise<Invitation> {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) throw new Error("MALFORMED_INVITE");

    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("BAD_INVITE_SIGNATURE");
    }

    const { i: inviteId, e: expiresAt } = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );
    if (Date.now() > expiresAt) throw new Error("INVITE_EXPIRED");

    const invitation = await this.invites.byId(inviteId);
    if (!invitation) throw new Error("INVITE_NOT_FOUND");
    if (invitation.status === "REVOKED") throw new Error("INVITE_REVOKED");
    if (invitation.status === "ACCEPTED") throw new Error("INVITE_ALREADY_USED");
    if (Date.now() > invitation.expiresAt) throw new Error("INVITE_EXPIRED");

    return invitation;
  }
}

function humanRole(role: Role): string {
  return {
    [Role.SUPER_ADMIN]: "Platform Admin",
    [Role.COMPANY_ADMIN]: "Company Admin",
    [Role.DISPATCHER]: "Dispatcher",
    [Role.DRIVER]: "Driver",
    [Role.RECEIVER]: "Receiver",
  }[role];
}