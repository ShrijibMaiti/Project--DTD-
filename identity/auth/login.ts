/**
 * identity/auth/login.ts
 * Phone/OTP for drivers and receivers (they don't have work email);
 * email/password for admins and dispatchers.
 *
 * Login NEVER creates a company or a user. Accounts exist only because an
 * admin invited them — see companies/invitations.ts. This is the rule that
 * prevents orphan companies and unattached users.
 */

import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { Role } from "@dtd/shared/roles.schema";
import type { PlatformModule } from "@dtd/shared/modules.schema";
import { signAccessToken, REFRESH_TTL_S } from "./jwt";

export interface UserRecord {
  id: string;
  companyId: string | null;
  role: Role;
  fullName: string;
  phone: string | null;
  email: string | null;
  passwordHash: string | null;
  status: "ACTIVE" | "SUSPENDED";
  tokenVersion: number;
}

export interface UserStore {
  byPhone(phone: string): Promise<UserRecord | null>;
  byEmail(email: string): Promise<UserRecord | null>;
  byId(id: string): Promise<UserRecord | null>;
  bumpTokenVersion(userId: string): Promise<number>;
}

export interface EntitlementReader {
  modulesFor(companyId: string): Promise<PlatformModule[]>;
}

export interface OtpService {
  send(phone: string): Promise<{ otpSession: string }>;
  verify(phone: string, otpToken: string): Promise<boolean>;
}

export interface SessionWriter {
  create(s: {
    id: string; userId: string; refreshToken: string;
    deviceLabel: string | null; expiresAt: number;
  }): Promise<void>;
}

export interface LoginAudit {
  record(e: {
    userId: string | null; identifier: string;
    action: "LOGIN_OK" | "LOGIN_FAIL" | "OTP_SENT"; reason?: string; at: number;
  }): Promise<void>;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; fullName: string; role: Role; companyId: string | null };
}

export class LoginService {
  constructor(
    private users: UserStore,
    private entitlements: EntitlementReader,
    private otp: OtpService,
    private sessions: SessionWriter,
    private audit: LoginAudit
  ) {}

  /** Step 1 for phone users. Deliberately does not reveal whether the number exists. */
  async requestOtp(phone: string): Promise<{ sent: true }> {
    const user = await this.users.byPhone(phone);
    if (user && user.status === "ACTIVE") {
      await this.otp.send(phone);
    }
    await this.audit.record({
      userId: user?.id ?? null, identifier: phone,
      action: "OTP_SENT", at: Date.now(),
    });
    return { sent: true }; // same response either way — no user enumeration
  }

  async loginWithOtp(
    phone: string, otpToken: string, deviceLabel?: string
  ): Promise<LoginResult> {
    const user = await this.users.byPhone(phone);
    if (!user || user.status !== "ACTIVE") {
      await this.fail(phone, "NO_SUCH_USER");
      throw new Error("INVALID_CREDENTIALS");
    }
    if (!(await this.otp.verify(phone, otpToken))) {
      await this.fail(phone, "BAD_OTP", user.id);
      throw new Error("INVALID_CREDENTIALS");
    }
    return this.issue(user, deviceLabel);
  }

  async loginWithPassword(
    email: string, password: string, deviceLabel?: string
  ): Promise<LoginResult> {
    const user = await this.users.byEmail(email.toLowerCase());
    if (!user || !user.passwordHash || user.status !== "ACTIVE") {
      await this.fail(email, "NO_SUCH_USER");
      throw new Error("INVALID_CREDENTIALS");
    }
    if (!verifyPassword(password, user.passwordHash)) {
      await this.fail(email, "BAD_PASSWORD", user.id);
      throw new Error("INVALID_CREDENTIALS");
    }
    return this.issue(user, deviceLabel);
  }

  private async issue(user: UserRecord, deviceLabel?: string): Promise<LoginResult> {
    const modules = user.companyId
      ? await this.entitlements.modulesFor(user.companyId)
      : [];

    const accessToken = signAccessToken({
      sub: user.id,
      companyId: user.companyId,
      role: user.role,
      modules,
      tokenVersion: user.tokenVersion,
    });

    const refreshToken = randomBytes(32).toString("base64url");
    await this.sessions.create({
      id: randomUUID(),
      userId: user.id,
      refreshToken,
      deviceLabel: deviceLabel ?? null,
      expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TTL_S,
    });

    await this.audit.record({
      userId: user.id,
      identifier: user.phone ?? user.email ?? user.id,
      action: "LOGIN_OK", at: Date.now(),
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id, fullName: user.fullName,
        role: user.role, companyId: user.companyId,
      },
    };
  }

  private fail(identifier: string, reason: string, userId?: string) {
    return this.audit.record({
      userId: userId ?? null, identifier,
      action: "LOGIN_FAIL", reason, at: Date.now(),
    });
  }
}