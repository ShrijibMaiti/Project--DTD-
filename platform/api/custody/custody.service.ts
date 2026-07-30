import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Hex, Address } from "viem";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { ManifestBuilder } from "@dtd/custody/manifest/builder";
import { HandoffService } from "@dtd/custody/manifest/handoff";
import { LifecycleIndex } from "@dtd/custody/doublescan/lifecycle-index";
import { PgManifestStore } from "@dtd/custody/db/manifest.store.pg";
import { PgLifecycleStore } from "@dtd/custody/db/lifecycle.store.pg";
import { PgCustodyStore, PgAlertSink } from "@dtd/custody/db/custody.store.pg";
import type { ScanContext } from "@dtd/shared/scan-event.schema";
import { CreateManifestDto, RecordScanDto } from "./custody.dto";

/**
 * Every method opens its own tenant-scoped transaction and constructs the
 * domain objects fresh against that transaction's client — mirrors exactly
 * how custody/tests/stores.integration.test.ts exercises the stores, just
 * with DatabaseService.withTenant instead of the test's local withTenant.
 */
@Injectable()
export class CustodyService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  async createManifest(companyId: string, userId: string, dto: CreateManifestDto) {
    return this.db.withTenant(companyId, async (c) => {
      const manifests = new PgManifestStore(c, companyId);
      const builder = new ManifestBuilder(manifests);

      try {
        const manifest = await builder.build({
          bookingId: dto.bookingId,
          transporterId: companyId,
          tripId: dto.tripId as Hex,
          pieces: dto.pieces as any,
          pieceCount: dto.pieceCount,
          loader: dto.loader as Address,
          driver: dto.driver as Address,
          receiver: dto.receiver as Address,
        });

        await this.audit.record({
          companyId, userId,
          action: "MANIFEST_CREATED", entity: "manifest", entityId: manifest.manifestId,
        });
        return manifest;
      } catch (err: any) {
        // ManifestBuilder throws plain Error with a machine-readable prefix —
        // translate to the HTTP vocabulary the rest of the API uses.
        if (err.message?.startsWith("MANIFEST_EXISTS_FOR_BOOKING")) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    });
  }

  async getManifest(companyId: string, manifestId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const manifest = await new PgManifestStore(c, companyId).get(manifestId);
      if (!manifest) throw new NotFoundException();
      return manifest;
    });
  }

  /** Pulls authoritative state from the chain and refreshes the read model. */
  async getCustodyStatus(companyId: string, manifestId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const handoff = new HandoffService(
        new PgCustodyStore(c, companyId),
        new PgManifestStore(c, companyId),
        new PgAlertSink(c, companyId)
      );
      return handoff.sync(manifestId);
    });
  }

  /** The dispute narrative for insurance claims — see HandoffService.attributeLoss. */
  async getAttribution(companyId: string, manifestId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const handoff = new HandoffService(
        new PgCustodyStore(c, companyId),
        new PgManifestStore(c, companyId),
        new PgAlertSink(c, companyId)
      );
      return handoff.attributeLoss(manifestId);
    });
  }

  async recordScan(companyId: string, userId: string, dto: RecordScanDto) {
    return this.db.withTenant(companyId, async (c) => {
      const lifecycle = new LifecycleIndex(new PgLifecycleStore(c, companyId));
      const result = await lifecycle.record({
        pieceId: dto.pieceId,
        manifestId: dto.manifestId ?? null,
        context: dto.context as ScanContext,
        scannerId: userId,
        locationHint: dto.locationHint,
        clientNonce: dto.clientNonce,
      });
      await this.audit.record({
        companyId, userId,
        action: "SCAN_RECORDED", entity: "piece", entityId: dto.pieceId,
        detail: { context: dto.context, isNew: result.isNew },
      });
      return result;
    });
  }

  async getPieceHistory(companyId: string, pieceId: string) {
    return this.db.withTenant(companyId, (c) =>
      new LifecycleIndex(new PgLifecycleStore(c, companyId)).history(pieceId)
    );
  }
}
