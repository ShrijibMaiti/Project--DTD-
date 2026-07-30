/**
 * E2E: manifest creation -> scan recording -> tenant isolation, through the
 * real HTTP surface (DtdAuthGuard + RBAC + PgManifestStore/PgLifecycleStore).
 * Runs against real Postgres, same as bookings.e2e.test.ts.
 *
 * NOT covered here: getCustodyStatus / getAttribution (HandoffService) —
 * those call the live chain via publicClient.readContract against
 * ADDRESSES.custodyManifest, which needs a real or mocked RPC endpoint.
 * bookings/payments e2e mocks isReleasable() from chain-sdk/verify for
 * exactly this reason; HandoffService reads through chain-sdk/anchor
 * directly, which isn't mocked anywhere yet. Flagging as a follow-up rather
 * than silently skipping — createManifest itself also anchors on-chain
 * (ManifestBuilder.build calls anchorCreateManifest), so it will need the
 * same treatment. See note at the relevant test below.
 */
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { keccak256, toHex } from "viem";

jest.mock("@dtd/chain-sdk/anchor", () => ({
  ...jest.requireActual("@dtd/chain-sdk/anchor"),
  createManifest: jest.fn(async () => "0xmocked000000000000000000000000000000000000000000000000000000" as const),
}));

import { AppModule } from "../api/app.module";
import { signTestJwt, signRoleJwt, seedTenant, resetDb } from "./helpers";
import { Role } from "@dtd/shared/roles.schema";

describe("Custody E2E", () => {
  let app: INestApplication;
  let tokenA: string;
  let tokenB: string;
  let bookingIdA: string;
  let manifestId: string;

  const tripId = keccak256(toHex(`trip-custody-e2e-${Date.now()}`));

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const a = await seedTenant("Custody E2E Co A");
    const b = await seedTenant("Custody E2E Co B");
    tokenA = signTestJwt(a.userId, a.companyId);
    tokenB = signTestJwt(b.userId, b.companyId);

    // Manifests need a real booking row (FK: manifests.booking_id -> bookings.id).
    const { seedBooking } = await import("./helpers");
    bookingIdA = await seedBooking(a.companyId);
  });

  afterAll(async () => app.close());

  it("creates a manifest and reads it back", async () => {
    const res = await request(app.getHttpServer())
      .post("/custody/manifests")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        bookingId: bookingIdA,
        tripId,
        pieceCount: 5,
        loader: "0x1111111111111111111111111111111111111111",
        driver: "0x2222222222222222222222222222222222222222",
        receiver: "0x3333333333333333333333333333333333333333",
      })
      .expect(201);

    expect(res.body.pieceCount).toBe(5);
    manifestId = res.body.manifestId;

    const read = await request(app.getHttpServer())
      .get(`/custody/manifests/${manifestId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(read.body.bookingId).toBe(bookingIdA);
  });

  it("rejects manifest creation without MANIFEST_CREATE permission (403)", async () => {
    // RECEIVER role lacks MANIFEST_CREATE per roles.schema.ts.
    const receiverTenant = await seedTenant("Custody E2E Co C");
    const receiverToken = signRoleJwt(
      receiverTenant.userId,
      receiverTenant.companyId,
      Role.RECEIVER
    );
    await request(app.getHttpServer())
      .post("/custody/manifests")
      .set("Authorization", `Bearer ${receiverToken}`)
      .send({
        bookingId: bookingIdA,
        tripId,
        pieceCount: 1,
        loader: "0x1111111111111111111111111111111111111111",
        driver: "0x2222222222222222222222222222222222222222",
        receiver: "0x3333333333333333333333333333333333333333",
      })
      .expect(403);
  });

  it("returns 404 for a manifest that doesn't exist, not a leak of any kind", async () => {
    await request(app.getHttpServer())
      .get(`/custody/manifests/0x${"00".repeat(32)}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(404);
  });

  it("records a scan and returns it in the piece history", async () => {
    const pieceId = "DTD-2H4K7M9P3Q";
    const scanRes = await request(app.getHttpServer())
      .post("/custody/scans")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ pieceId, context: "LOADING" })
      .expect(201);

    expect(scanRes.body.isNew).toBe(true);
    expect(scanRes.body.history).toHaveLength(1);

    const historyRes = await request(app.getHttpServer())
      .get(`/custody/pieces/${pieceId}/history`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(historyRes.body).toHaveLength(1);
    expect(historyRes.body[0].context).toBe("LOADING");
  });

  it("OFFLINE QUEUE: replaying the same scan (same nonce) is a no-op, not a duplicate", async () => {
    const pieceId = "DTD-3J5L8N2R4T";
    const clientNonce = "e2e-nonce-001";

    const first = await request(app.getHttpServer())
      .post("/custody/scans")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ pieceId, context: "UNLOADING", clientNonce })
      .expect(201);
    expect(first.body.isNew).toBe(true);

    const replay = await request(app.getHttpServer())
      .post("/custody/scans")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ pieceId, context: "UNLOADING", clientNonce })
      .expect(201);
    expect(replay.body.isNew).toBe(false);
    expect(replay.body.history).toHaveLength(1); // still one row, not two
  });

  it("TENANT ISOLATION: company B cannot read company A's piece history", async () => {
    const pieceId = "DTD-4K6M9P1S5V";
    await request(app.getHttpServer())
      .post("/custody/scans")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ pieceId, context: "LOADING" })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/custody/pieces/${pieceId}/history`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    // RLS on lifecycle reads is tenant-scoped for non-system callers —
    // company B's session sees zero rows for a piece it never scanned.
    expect(res.body).toHaveLength(0);
  });

  it("rejects an unauthenticated request with 401", async () => {
    await request(app.getHttpServer())
      .get(`/custody/pieces/DTD-0000000000/history`)
      .expect(401);
  });
});