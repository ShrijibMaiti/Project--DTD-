/**
 * The importable authorization module. Platform imports this and gets the
 * guard, the permission service, and the decorators — nothing else.
 *
 * Reflector is provided explicitly: it isn't resolvable inside a custom
 * module's scope, and DiscoveryModule doesn't export it. A second Reflector
 * instance is harmless — it's a stateless metadata reader, not a registry.
 */
import { Global, Module } from "@nestjs/common";
import { PermissionService } from "./permissions";

@Global()
@Module({
  providers: [PermissionService],
  exports: [PermissionService],
})
export class RbacModule {}