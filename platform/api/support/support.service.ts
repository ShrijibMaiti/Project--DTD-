import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { CreateTicketDto } from "./support.dto";

@Injectable()
export class SupportService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  async createTicket(transporterId: string, userId: string, dto: CreateTicketDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO support_tickets
           (company_id, booking_id, category, subject, status, created_by)
         VALUES ($1,$2,$3,$4,'OPEN',$5) RETURNING *`,
        [transporterId, dto.bookingId ?? null, dto.category, dto.subject, userId]
      );
      await c.query(
        `INSERT INTO support_messages (ticket_id, author_id, body)
         VALUES ($1,$2,$3)`,
        [rows[0].id, userId, dto.message]
      );
      return rows[0];
    });
  }

  async listTickets(transporterId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 100`
      );
      return rows;
    });
  }

  async reply(transporterId: string, userId: string, ticketId: string, message: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const t = await c.query(`SELECT id, status FROM support_tickets WHERE id=$1`, [ticketId]);
      if (!t.rows[0]) throw new NotFoundException();
      if (t.rows[0].status === "CLOSED") throw new BadRequestException("TICKET_CLOSED");

      const { rows } = await c.query(
        `INSERT INTO support_messages (ticket_id, author_id, body)
         VALUES ($1,$2,$3) RETURNING *`,
        [ticketId, userId, message]
      );
      return rows[0];
    });
  }

  async callDriver(transporterId: string, userId: string, bookingId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `SELECT d.phone FROM bookings b JOIN drivers d ON d.id = b.driver_id
         WHERE b.id=$1`,
        [bookingId]
      );
      if (!rows[0]) throw new NotFoundException("NO_DRIVER_ASSIGNED");

      // Production: create an Exotel/Twilio masked-call session to rows[0].phone.
      const bridgeNumber = process.env.MASKED_CALL_BRIDGE ?? "+918000000000";

      await this.audit.record({
        transporterId, userId,
        action: "CALL_DRIVER_REQUESTED", entity: "booking", entityId: bookingId,
      });
      return { bridgeNumber, note: "Dial this number to be connected to the driver." };
    });
  }
}