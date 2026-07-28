/**
 * Resolves the authenticated company from the bearer token and pins it to
 * the request.
 *
 * TRANSITIONAL: this middleware is being replaced by Domain 7's DtdAuthGuard,
 * which additionally enforces roles and module entitlements. Until every
 * controller carries its decorators, this reads the same Domain 7 token shape
 * ({sub, companyId, role, modules}) and exposes the company id under the
 * legacy `companyId` name so the 11 existing service files keep working.
 *
 * The claim is `companyId`; the property is `companyId`; they hold the
 * SAME uuid. Migration B renames the columns and this ambiguity disappears.
 */
import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import type { Role } from "@dtd/shared/roles.schema";
import type { PlatformModule } from "@dtd/shared/modules.schema";

export interface TenantRequest extends Request {
  companyId: string;
  userId: string;
  role: Role;
  modules: PlatformModule[];
}

interface DtdTokenPayload {
  sub: string;
  companyId: string | null;
  role: Role;
  modules: PlatformModule[];
  tokenVersion: number;
  iat: number;
  exp: number;
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: TenantRequest, _res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("NO_TOKEN");

    const payload = this.verifyJwt(auth.slice(7));

    // A non-SuperAdmin token without a company is structurally invalid.
    // Rejecting beats defaulting: a null tenant would set app.company_id to ''
    // and silently fail every RLS policy rather than erroring loudly.
    if (!payload.companyId && payload.role !== ("SUPER_ADMIN" as Role)) {
      throw new UnauthorizedException("MISSING_COMPANY_SCOPE");
    }

    req.userId = payload.sub;
    req.companyId = payload.companyId!;
    req.role = payload.role;
    req.modules = payload.modules ?? [];
    next();
  }

  private verifyJwt(token: string): DtdTokenPayload {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) throw new UnauthorizedException("MALFORMED_TOKEN");

    const expected = createHmac("sha256", process.env.JWT_SECRET!)
      .update(`${h}.${p}`)
      .digest("base64url");

    // Constant-time compare — a plain !== leaks timing information.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("BAD_SIGNATURE");
    }

    const payload = JSON.parse(
      Buffer.from(p, "base64url").toString()
    ) as DtdTokenPayload;

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException("EXPIRED");
    }
    return payload;
  }
}