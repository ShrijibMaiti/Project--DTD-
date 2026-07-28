/**
 * identity/auth/session.ts
 * Refresh, revoke, device list.
 *
 * Refresh is where entitlement staleness gets corrected: every refresh
 * re-reads the company's live module set, so a downgrade takes effect within
 * one access-token lifetime (15 min) without a forced logout.
 */

import { randomBytes } from "crypto";
import { signAccessToken, REFRESH_TTL_S } from "./jwt";
import type { UserStore, EntitlementReader } from "./login";

export interface Session {
  id: string;
  userId: string;
  refreshToken: string;
  deviceLabel: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  revokedAt: number | null;
}

export interface SessionStore {
  create(s: Omit<Session, "createdAt" | "lastUsedAt" | "revokedAt">): Promise<void>;
  byRefreshToken(token: string): Promise<Session | null>;
  rotate(sessionId: string, newToken: string, expiresAt: number): Promise<void>;
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<number>;
  listForUser(userId: string): Promise<Session[]>;
}

export class SessionService {
  constructor(
    private sessions: SessionStore,
    private users: UserStore,
    private entitlements: EntitlementReader
  ) {}

  /**
   * Refresh with rotation: the old token dies the moment a new one is issued.
   * If a stolen token is replayed after the legitimate client rotated, the
   * lookup fails — and that failure is a detectable theft signal.
   */
  async refresh(refreshToken: string): Promise<{
    accessToken: string; refreshToken: string;
  }> {
    const session = await this.sessions.byRefreshToken(refreshToken);
    if (!session) throw new Error("INVALID_REFRESH_TOKEN");
    if (session.revokedAt) throw new Error("SESSION_REVOKED");
    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error("SESSION_EXPIRED");
    }

    const user = await this.users.byId(session.userId);
    if (!user || user.status !== "ACTIVE") {
      await this.sessions.revoke(session.id);
      throw new Error("USER_INACTIVE");
    }

    // Live entitlement read — this is how plan changes propagate.
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

    const next = randomBytes(32).toString("base64url");
    await this.sessions.rotate(
      session.id, next, Math.floor(Date.now() / 1000) + REFRESH_TTL_S
    );

    return { accessToken, refreshToken: next };
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.byRefreshToken(refreshToken);
    if (session) await this.sessions.revoke(session.id);
  }

  /** Used on role change, suspension, or suspected compromise. */
  async logoutEverywhere(userId: string): Promise<number> {
    await this.users.bumpTokenVersion(userId); // invalidates live access tokens too
    return this.sessions.revokeAllForUser(userId);
  }

  async devices(userId: string) {
    const all = await this.sessions.listForUser(userId);
    return all
      .filter((s) => !s.revokedAt && s.expiresAt > Math.floor(Date.now() / 1000))
      .map((s) => ({
        id: s.id,
        deviceLabel: s.deviceLabel ?? "Unknown device",
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
      }));
  }

  async revokeDevice(userId: string, sessionId: string): Promise<void> {
    const all = await this.sessions.listForUser(userId);
    const target = all.find((s) => s.id === sessionId);
    if (!target) throw new Error("SESSION_NOT_FOUND");
    await this.sessions.revoke(sessionId);
  }
}