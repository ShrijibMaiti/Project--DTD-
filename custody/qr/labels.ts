/**
 * custody/qr/labels.ts
 * The loading-dock print pipeline: manifest -> A4 label sheets (PDF).
 *
 * Layout: 3 cols x 8 rows = 24 labels/page on standard A4 sticker stock.
 * Each label carries the QR, the human-readable ID with check digit, the
 * piece index (7/200 — so the dock can spot a missing sticker), and the
 * booking's short code.
 */

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { Manifest } from "@dtd/shared/manifest.schema";
import { qrPayload, checkDigit } from "./generator";

const COLS = 3;
const ROWS = 8;
const PER_PAGE = COLS * ROWS;

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN = 28;

export interface LabelSheetOptions {
  baseUrl?: string;
  /** Print only a subset — e.g. reprinting damaged labels. */
  onlyPieceIds?: string[];
}

export async function renderLabelSheet(
  manifest: Manifest,
  opts: LabelSheetOptions = {}
): Promise<Buffer> {
  const pieces = opts.onlyPieceIds?.length
    ? manifest.pieces.filter((p) => opts.onlyPieceIds!.includes(p.pieceId))
    : manifest.pieces;

  if (pieces.length === 0) throw new Error("NO_PIECES_TO_PRINT");

  const doc = new PDFDocument({ size: "A4", margin: MARGIN, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  const cellW = (PAGE_W - MARGIN * 2) / COLS;
  const cellH = (PAGE_H - MARGIN * 2 - 30) / ROWS; // 30pt header
  const shortBooking = manifest.bookingId.slice(0, 8).toUpperCase();

  // Pre-render QR PNGs (buffered; pdfkit needs sync image data).
  const qrs = await Promise.all(
    pieces.map((p) =>
      QRCode.toBuffer(qrPayload(p.pieceId, opts.baseUrl), {
        errorCorrectionLevel: "M", // survives dirt/scuffs on a warehouse box
        margin: 1,
        width: 240,
      })
    )
  );

  for (let start = 0; start < pieces.length; start += PER_PAGE) {
    doc.addPage();
    const pageNo = Math.floor(start / PER_PAGE) + 1;
    const pageTotal = Math.ceil(pieces.length / PER_PAGE);

    doc
      .fontSize(9)
      .fillColor("#444")
      .text(
        `DTD manifest ${manifest.manifestId.slice(0, 10)}…  ·  booking ${shortBooking}  ·  ` +
          `${manifest.pieceCount} pieces  ·  sheet ${pageNo}/${pageTotal}`,
        MARGIN,
        MARGIN - 12
      );

    for (let i = 0; i < PER_PAGE && start + i < pieces.length; i++) {
      const idx = start + i;
      const piece = pieces[idx];
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = MARGIN + col * cellW;
      const y = MARGIN + 22 + row * cellH;

      // cut guide
      doc.rect(x, y, cellW - 6, cellH - 6).strokeColor("#DDD").lineWidth(0.5).stroke();

      const qrSize = Math.min(cellW, cellH) - 34;
      doc.image(qrs[idx], x + 6, y + 5, { width: qrSize, height: qrSize });

      doc
        .fontSize(8)
        .fillColor("#000")
        .text(`${piece.pieceId}-${checkDigit(piece.pieceId)}`, x + 6, y + qrSize + 8, {
          width: cellW - 14,
        });
      doc
        .fontSize(7)
        .fillColor("#666")
        .text(
          `${idx + 1}/${manifest.pieceCount}${piece.sku ? `  ${piece.sku}` : ""}`,
          x + 6,
          y + qrSize + 18,
          { width: cellW - 14 }
        );
    }
  }

  doc.end();
  return done;
}

/** Convenience: the dock's "print everything" call. */
export async function renderFullSheet(manifest: Manifest): Promise<Buffer> {
  return renderLabelSheet(manifest);
}