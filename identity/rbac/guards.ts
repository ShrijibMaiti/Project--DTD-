/**
 * identity/rbac/guards.ts
 * @Roles(), @RequiresPermission(), @RequiresModule() — the decorators every
 * controller in every domain uses. Ad-hoc authorization checks inside service
 * methods are forbidden by convention: one matrix, one gate, one answer.
 */

import {
  CanActivate, ExecutionContext, Injectable, SetMetadata,
  UnauthorizedException, ForbiddenException, HttpException, HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Role, Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";
import { verifyAccessToken, TokenError, type DtdClaims } from "../auth/jwt";
import {
  PermissionService, ForbiddenError, PaymentRequiredError, type Actor,
} from "./permissions";

export const ROLES_KEY = "dtd:roles";
export const PERMISSION_KEY = "dtd:permission";
export const MODULE_KEY = "dtd:module";
export const PUBLIC_KEY = "dtd:public";
export const ANY_PERMISSION_KEY = "dtd:any_permission";

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const RequiresPermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);
export const RequiresModule = (m: PlatformModule) => SetMetadata(MODULE_KEY, m);
/** Webhooks and the public verify page. Must be explicit — never inferred. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Passes if the actor holds ANY ONE of the listed permissions.
 *
 * Use only where one resource is legitimately reachable by roles with
 * different permission sets. Do NOT use it to paper over a route that should
 * have been split — if the two callers are doing different things, they want
 * different routes. See custody scans (split) vs custody reconcile (shared).
 */
export const RequiresAnyPermission = (...ps: Permission[]) =>
  SetMetadata(ANY_PERMISSION_KEY, ps);

export interface DtdRequest extends Request {
  actor: Actor;
  claims: DtdClaims;
}

@Injectable()
export class DtdAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissions: PermissionService
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const cls = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, cls])) {
      return true;
    }

    const req = context.switchToHttp().getRequest();

    // ---- authenticate
    const auth = req.headers?.authorization;
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("NO_TOKEN");

    let claims: DtdClaims;
    try {
      claims = verifyAccessToken(auth.slice(7));
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof TokenError ? err.message : "INVALID_TOKEN"
      );
    }

    const actor: Actor = {
      userId: claims.sub,
      companyId: claims.companyId,
      role: claims.role,
      modules: claims.modules,
    };
    req.actor = actor;
    req.claims = claims;

    // ---- authorize
    const requiredModule = this.reflector.getAllAndOverride<PlatformModule>(
      MODULE_KEY, [handler, cls]
    );
    const requiredPermission = this.reflector.getAllAndOverride<Permission>(
      PERMISSION_KEY, [handler, cls]
    );
    const anyPermission = this.reflector.getAllAndOverride<Permission[]>(
      ANY_PERMISSION_KEY,
      [handler, cls],
    );
    const allowedRoles = this.reflector.getAllAndOverride<Role[]>(
      ROLES_KEY, [handler, cls]
    );

    try {
      // Subscription first: 402 is a sales conversation, 403 is a support ticket.
      if (requiredModule) this.permissions.assertModule(actor, requiredModule);
      if (allowedRoles?.length && !allowedRoles.includes(actor.role)) {
        throw new ForbiddenError(`role ${actor.role} not in [${allowedRoles.join(", ")}]`);
      }
      if (requiredPermission) this.permissions.assert(actor, requiredPermission);

      if (anyPermission?.length &&
          !anyPermission.some((p) => this.permissions.can(actor, p))) {
        throw new ForbiddenError(
          `${actor.role} holds none of [${anyPermission.join(", ")}]`
        );
      }
    } catch (err) {
      if (err instanceof PaymentRequiredError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.PAYMENT_REQUIRED,
            error: "Payment Required",
            message: err.message,
            module: err.module,
            upgradeHint: `Enable ${err.module} by upgrading your plan.`,
          },
          HttpStatus.PAYMENT_REQUIRED
        );
      }
      if (err instanceof ForbiddenError) throw new ForbiddenException(err.message);
      throw err;
    }

    // Legacy shim: platform controllers read req.companyId / req.userId.
    // Remove once every controller uses @CurrentActor().
    req.companyId = actor.companyId;
    req.userId = actor.userId;
    req.role = actor.role;
    req.modules = actor.modules;
    return true;
  }
}

/** Param decorator: `@CurrentActor() actor: Actor` */
export const CurrentActor = () => (
  target: any, key: string, index: number
): void => {
  const existing = Reflect.getMetadata("dtd:actor_params", target[key]) ?? [];
  Reflect.defineMetadata("dtd:actor_params", [...existing, index], target[key]);
};