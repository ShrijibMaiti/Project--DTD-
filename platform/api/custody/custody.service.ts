import {
  BadRequestException, Injectable, NotFoundException, UnauthorizedException,
} from "@nestjs/common";
import type { Hex, Address } from "viem";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { ManifestBuilder } from "@dtd/custody/manifest/builder";
import { HandoffService } from "@dtd/custody/manifest/handoff";
import { LifecycleIndex } from "@dtd/custody/doublescan/lifecycle-index";
import { ReconcileCounter } from "@dtd/custody/reconcile/counter";
import { ReleaseGate } from "@dtd/custody/reconcile/release-gate";
import { PgManifestStore } from "@dtd/custody/db/manifest.store.pg";
import { PgLifecycleStore } from "@dtd/custody/db/lifecycle.store.pg";
import { PgCustodyStore, PgAlertSink } from "@dtd/custody/db/custody.store.pg";
import { SignerService } from "@dtd/chain/keys/signer-service";
import { PgKeyStore, PreloadedKeyStore } from "@dtd/chain/keys/key-store.pg";
import { OtpService, ConsoleOtpSender, PreVerifiedOtp } from "@dtd/chain/keys/otp";
import { PgSignerAudit, BufferedSignerAudit } from "@dtd/chain/keys/signer-audit.pg";
import { ScanContext } from "@dtd/shared/scan-event.schema";
import {
  CreateManifestDto, ScanDto, ConfirmDeliveryDto, RequestDeliveryOtpDto,
} from "./custody.dto";

/**
 * Every method opens its own tenant-scoped transaction and constructs the
 * domain objects fresh against that transaction's client.
 *
 * CONNECTION DISCIPLINE — read before adding a method here.
 * A request must hold at most ONE PoolClient at a time. The pool is capped at
 * 20; a method that holds a tenant client while opening a system client halves
 * effective capacity and deadlocks under load. confirmDelivery() below is the
 * hard case — signing needs system scope, reconciliation needs tenant scope —
 * and it is solved by doing the system work FIRST, in its own short
 * transaction, then preloading the results into memory for the tenant phase.
 * See PreloadedKeyStore / PreVerifiedOtp for the full reasoning.
 */
@Injectable()
export class CustodyService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  // ================================================================
  // Manifests
  // ================================================================

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
    return this.db.withTenant(companyId, async (c) =>
      this.handoff(c, companyId).sync(manifestId)
    );
  }

  /** The dispute narrative for insurance claims — see HandoffService. */
  async getAttribution(companyId: string, manifestId: string) {
    return this.db.withTenant(companyId, async (c) =>
      this.handoff(c, companyId).attributeLoss(manifestId)
    );
  }

  // ================================================================
  // A4 — reconciliation
  // ================================================================

  /**
   * 175/200, and WHICH 25 are missing.
   *
   * Read-only and side-effect free — deliberately. This is what the receiver
   * looks at before deciding whether to sign, and what an ops dashboard polls.
   * Nothing here writes, transitions state, or touches the chain.
   */
  async reconcile(companyId: string, manifestId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const manifests = new PgManifestStore(c, companyId);
      if (!(await manifests.get(manifestId))) throw new NotFoundException();

      const counter = new ReconcileCounter(
        manifests,
        new LifecycleIndex(new PgLifecycleStore(c, companyId))
      );
      const result = await counter.reconcile(manifestId);
      return { ...result, summary: ReconcileCounter.summarize(result) };
    });
  }

  // ================================================================
  // A2 — delivery confirmation (the money seam)
  // ================================================================

  /**
   * Step 1 of two: send the receiver an OTP.
   *
   * Runs entirely in system scope — otp_challenges and participant_keys are
   * system_only RLS. Also mints the receiver's signing key if this is their
   * first delivery, so the key exists by the time they tap Confirm.
   */
  async requestDeliveryOtp(
    companyId: string, manifestId: string, dto: RequestDeliveryOtpDto
  ) {
    // Tenant-scoped existence check first, in its own transaction, so a
    // caller cannot probe manifests belonging to another company.
    const manifest = await this.db.withTenant(companyId, (c) =>
      new PgManifestStore(c, companyId).get(manifestId)
    );
    if (!manifest) throw new NotFoundException();

    return this.db.asSystem(async (c) => {
      const signer = new SignerService(
        new PgKeyStore(c),
        new OtpService(c, new ConsoleOtpSender()),
        new PgSignerAudit(c)
      );
      const address = await signer.ensureKey(dto.receiverPhone);
      const { expiresAt } = await new OtpService(c, new ConsoleOtpSender())
        .issue(dto.receiverPhone);

      // The address is returned so the caller can verify it matches the
      // manifest's declared receiver BEFORE bothering the human with a code.
      return {
        sent: true,
        expiresAt,
        signingAddress: address,
        matchesManifest: address.toLowerCase() === manifest.receiver.toLowerCase(),
      };
    });
  }

  /**
   * Step 2 of two: the receiver signs for the count that was ACTUALLY scanned.
   *
   * This is the write that ReleaseGate was built for and that nothing has ever
   * been able to call. It submits the true scanned count to
   * CustodyManifest.confirmDelivery() on-chain — short deliveries record as
   * Short and freeze payment, which is the entire point of the product.
   *
   * Returns a ReleaseDecision. The caller (Phase B orchestration) uses
   * decision.chainStatus to transition the booking — from THIS write path,
   * never from a GET.
   */
  async confirmDelivery(
    companyId: string, userId: string, manifestId: string, dto: ConfirmDeliveryDto
  ) {
    // ---- Phase 1: system scope, short-lived. Verify OTP, load key material.
    // Committed independently on purpose: an OTP that reached the server must
    // be burned even if the delivery that follows fails, or it stays replayable.
    const { keyRecord, signingAddress } = await this.db.asSystem(async (c) => {
      const otp = new OtpService(c, new ConsoleOtpSender());
      if (!(await otp.verify(dto.receiverPhone, dto.otpToken))) {
        throw new UnauthorizedException("OTP_INVALID");
      }
      const store = new PgKeyStore(c);
      const rec = await store.get(dto.receiverPhone);
      if (!rec) {
        throw new BadRequestException(
          "RECEIVER_HAS_NO_SIGNING_KEY: request an OTP first to mint one"
        );
      }
      return { keyRecord: rec, signingAddress: rec.address };
    });

    // ---- Phase 2: tenant scope. Reconcile, sign, anchor, alert, evaluate.
    // Exactly one client is held here; the signer reads from memory.
    const preloadedKeys = new PreloadedKeyStore(keyRecord);
    const bufferedAudit = new BufferedSignerAudit();

    let decision;
    try {
      decision = await this.db.withTenant(companyId, async (c) => {
        const manifests = new PgManifestStore(c, companyId);
        const manifest = await manifests.get(manifestId);
        if (!manifest) throw new NotFoundException();

        if (manifest.receiver.toLowerCase() !== signingAddress.toLowerCase()) {
          throw new BadRequestException(
            "SIGNER_IS_NOT_THE_MANIFEST_RECEIVER"
          );
        }

        const counter = new ReconcileCounter(
          manifests,
          new LifecycleIndex(new PgLifecycleStore(c, companyId))
        );

        const gate = new ReleaseGate(
          counter,
          this.handoff(c, companyId),
          manifests,
          new SignerService(
            preloadedKeys,
            new PreVerifiedOtp(dto.receiverPhone),
            bufferedAudit
          ),
          new PgAlertSink(c, companyId)
        );

        return gate.confirmAndSign({
          manifestId,
          receiverPhone: dto.receiverPhone,
          otpToken: dto.otpToken,
        });
      });
    } finally {
      // Flush even on failure — an unflushed signer audit is a lost record of
      // a signing ATTEMPT, which is precisely what an investigation needs.
      if (bufferedAudit.pending > 0 || preloadedKeys.hasPendingWrites) {
        await this.db.asSystem(async (c) => {
          await bufferedAudit.flush(c);
          await preloadedKeys.flush(c);
        });
      }
    }

    await this.audit.record({
      companyId, userId,
      action: "DELIVERY_CONFIRMED", entity: "manifest", entityId: manifestId,
      detail: {
        releasable: decision.releasable,
        reason: decision.reason,
        scanned: decision.reconcile.scanned,
        expected: decision.reconcile.expected,
        missing: decision.reconcile.missing,
      },
    });

    return decision;
  }

  /**
   * Read-only release evaluation. Safe to poll; makes no chain writes.
   * Used by dashboards and by the payments reconciliation job.
   */
  async evaluateRelease(companyId: string, manifestId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const manifests = new PgManifestStore(c, companyId);
      if (!(await manifests.get(manifestId))) throw new NotFoundException();

      const gate = new ReleaseGate(
        new ReconcileCounter(
          manifests,
          new LifecycleIndex(new PgLifecycleStore(c, companyId))
        ),
        this.handoff(c, companyId),
        manifests,
        // evaluate() never signs, so no signer is exercised on this path.
        null as any,
        new PgAlertSink(c, companyId)
      );
      return gate.evaluate(manifestId);
    });
  }

  // ================================================================
  // A3 — scans, split by physical event
  // ================================================================

  /**
   * Context is a parameter of the METHOD, not of the request body. The route
   * that was called determines it, and the route is permission-gated to the
   * role that performs that physical act. A receiver cannot forge a
   * loading-dock scan by changing a JSON field.
   */
  async recordScan(
    companyId: string, userId: string, context: ScanContext, dto: ScanDto
  ) {
    return this.db.withTenant(companyId, async (c) => {
      const lifecycle = new LifecycleIndex(new PgLifecycleStore(c, companyId));
      const result = await lifecycle.record({
        pieceId: dto.pieceId,
        manifestId: dto.manifestId ?? null,
        context,
        scannerId: userId,
        locationHint: dto.locationHint,
        clientNonce: dto.clientNonce,
      });
      await this.audit.record({
        companyId, userId,
        action: "SCAN_RECORDED", entity: "piece", entityId: dto.pieceId,
        detail: { context, isNew: result.isNew },
      });
      return result;
    });
  }

  /** Batch flush from the offline PWA queue. One transaction, one client. */
  async recordScanBatch(
    companyId: string, userId: string, context: ScanContext, scans: ScanDto[]
  ) {
    return this.db.withTenant(companyId, async (c) => {
      const lifecycle = new LifecycleIndex(new PgLifecycleStore(c, companyId));
      let accepted = 0;
      let duplicates = 0;
      for (const s of scans) {
        const r = await lifecycle.record({
          pieceId: s.pieceId,
          manifestId: s.manifestId ?? null,
          context,
          scannerId: userId,
          locationHint: s.locationHint,
          clientNonce: s.clientNonce,
        });
        r.isNew ? accepted++ : duplicates++;
      }
      await this.audit.record({
        companyId, userId,
        action: "SCAN_BATCH_RECORDED", entity: "manifest",
        entityId: scans[0]?.manifestId ?? "unknown",
        detail: { context, accepted, duplicates, total: scans.length },
      });
      return { accepted, duplicates, total: scans.length };
    });
  }

  async getPieceHistory(companyId: string, pieceId: string) {
    return this.db.withTenant(companyId, (c) =>
      new LifecycleIndex(new PgLifecycleStore(c, companyId)).history(pieceId)
    );
  }

  // ================================================================
  // internals
  // ================================================================

  private handoff(c: any, companyId: string): HandoffService {
    return new HandoffService(
      new PgCustodyStore(c, companyId),
      new PgManifestStore(c, companyId),
      new PgAlertSink(c, companyId)
    );
  }
}
