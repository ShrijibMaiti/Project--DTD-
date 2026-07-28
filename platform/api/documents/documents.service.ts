import { Injectable, NotFoundException } from "@nestjs/common";
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { registerDocument, DocType } from "@dtd/chain-sdk/anchor";

/**
 * Every document follows the same pipeline:
 *   render PDF -> store encrypted (S3/IPFS) -> keccak256 the bytes ->
 *   DocumentRegistry.registerDocument() -> WhatsApp the download link.
 * The FILE holds the PII; the CHAIN holds only the fingerprint.
 */

interface PdfRenderer {
  render(docType: string, payload: Record<string, unknown>): Promise<Uint8Array>;
}
interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<string>; // returns storage key
}
interface WhatsAppSender {
  sendDocumentLink(phone: string, title: string, url: string): Promise<void>;
}

// Stubs — swap for pdfkit/puppeteer, S3 client, and WhatsApp Business API.
class StubPdf implements PdfRenderer {
  async render(docType: string, payload: Record<string, unknown>) {
    return new TextEncoder().encode(JSON.stringify({ docType, payload, v: 1 }));
  }
}
class StubBlob implements BlobStore {
  async put(key: string) { return key; }
}
class StubWhatsApp implements WhatsAppSender {
  async sendDocumentLink() { /* wire WhatsApp Business API here */ }
}

const DOC_TYPE_MAP: Record<string, DocType> = {
  BILTY: DocType.Bilty,
  POD: DocType.POD,
  INVOICE: DocType.Invoice,
};

@Injectable()
export class DocumentsService {
  private pdf: PdfRenderer = new StubPdf();
  private blob: BlobStore = new StubBlob();
  private whatsapp: WhatsAppSender = new StubWhatsApp();

  constructor(private db: DatabaseService, private audit: AuditService) {}

  async generate(
    transporterId: string,
    userId: string,
    dto: { bookingId: string; docType: "BILTY" | "POD" | "INVOICE"; payload: Record<string, unknown> }
  ) {
    return this.db.withTenant(transporterId, async (c) => {
      const booking = await c.query(
        `SELECT b.id, b.trip_id, t.contact_phone
         FROM bookings b JOIN transporters t ON t.id = b.company_id
         WHERE b.id=$1`,
        [dto.bookingId]
      );
      if (!booking.rows[0]) throw new NotFoundException("BOOKING_NOT_FOUND");

      // 1. Render
      const bytes = await this.pdf.render(dto.docType, dto.payload);

      // 2. Store (encrypted at rest via bucket policy)
      const storageKey = await this.blob.put(
        `docs/${transporterId}/${dto.bookingId}/${dto.docType}-${Date.now()}.pdf`,
        bytes
      );

      // 3. Fingerprint
      const docHash = keccak256(bytes);

      // 4. Anchor — the tamper-proofing moment
      const tripId = (booking.rows[0].trip_id ??
        keccak256(new TextEncoder().encode(dto.bookingId))) as Hex;
      const txHash = await registerDocument(docHash, tripId, DOC_TYPE_MAP[dto.docType]);

      // 5. Record
      const { rows } = await c.query(
        `INSERT INTO documents
           (company_id, booking_id, doc_type, storage_key, doc_hash, chain_tx, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ANCHORED') RETURNING *`,
        [transporterId, dto.bookingId, dto.docType, storageKey, docHash, txHash]
      );

      // 6. Deliver
      await this.whatsapp.sendDocumentLink(
        booking.rows[0].contact_phone,
        `${dto.docType} — Booking ${dto.bookingId.slice(0, 8)}`,
        `${process.env.APP_BASE_URL}/documents/download/${rows[0].id}`
      );

      await this.audit.record({
        transporterId, userId,
        action: "DOCUMENT_ANCHORED", entity: "document", entityId: rows[0].id,
        detail: { docType: dto.docType, docHash, txHash },
      });
      return rows[0];
    });
  }

  async listForBooking(transporterId: string, bookingId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, doc_type, doc_hash, chain_tx, status, created_at
         FROM documents WHERE booking_id=$1 ORDER BY created_at DESC`,
        [bookingId]
      );
      return rows;
    });
  }
}