import { Injectable } from "@nestjs/common";
import { DatabaseService } from "./database.service";

@Injectable()
export class AuditService {
  constructor(private db: DatabaseService) {}

  async record(params: {
    transporterId: string;
    userId: string | null;
    action: string;
    entity: string;
    entityId: string;
    detail?: Record<string, unknown>;
  }) {
    await this.db.asSystem((c) =>
      c.query(
        `INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          params.transporterId,
          params.userId,
          params.action,
          params.entity,
          params.entityId,
          JSON.stringify(params.detail ?? {}),
        ]
      )
    );
  }
}