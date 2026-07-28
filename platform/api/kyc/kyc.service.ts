import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { SubmitKycDto, ReviewKycDto } from "./kyc.dto";

/**
 * Phase 1: document upload + manual ops review.
 * Roadmap (kyc/providers/): DigiLocker pull for Aadhaar/PAN, Vahan API for
 * truck RC validation, Sarathi for driver license — each provider becomes an
 * automated verifier that writes the same kyc_records rows, and eventually a
 * verifiable-credential issuer.
 */
@Injectable()
export class KycService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  async submit(transporterId: string, userId: string, dto: SubmitKycDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO kyc_records
           (transporter_id, doc_kind, storage_key, subject_type, subject_id, status)
         VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id, status, created_at`,
        [transporterId, dto.docKind, dto.storageKey, dto.subjectType, dto.subjectId]
      );
      await this.audit.record({
        transporterId, userId,
        action: "KYC_SUBMITTED", entity: "kyc_record", entityId: rows[0].id,
        detail: { docKind: dto.docKind, subjectType: dto.subjectType },
      });
      return rows[0];
    });
  }

  async status(transporterId: string, subjectType: string, subjectId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `SELECT doc_kind, status, reviewed_at
         FROM kyc_records WHERE subject_type=$1 AND subject_id=$2
         ORDER BY created_at DESC`,
        [subjectType, subjectId]
      );
      const allVerified =
        rows.length > 0 && rows.every((r: any) => r.status === "VERIFIED");
      return { records: rows, fullyVerified: allVerified };
    });
  }

  async review(transporterId: string, userId: string, id: string, dto: ReviewKycDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `UPDATE kyc_records
         SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now()
         WHERE id=$1 RETURNING id, status`,
        [id, dto.decision, dto.note, userId]
      );
      if (!rows[0]) throw new NotFoundException();
      await this.audit.record({
        transporterId, userId,
        action: `KYC_${dto.decision}`, entity: "kyc_record", entityId: id,
      });
      return rows[0];
    });
  }
}