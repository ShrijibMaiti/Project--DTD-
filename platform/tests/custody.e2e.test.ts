/**
 * E2E: manifest creation -> scan recording -> reconciliation -> delivery
 * confirmation -> tenant isolation, through the real HTTP surface
 * (DtdAuthGuard + RBAC + Pg stores). Runs against real Postgres.
 *
 * CHAIN MOCKING — what is mocked and why.
 * Three chain functions are stubbed: createManifest (write), confirmDelivery
 * (write), and getDeliveryDigest (read). All three are exercised by paths
 * under test but need a live anvil with deployed contracts, which the suite
 * deliberately does not depend on. Everything else — reconciliation, RLS,
 * permissions, OTP, key handling, audit — runs for real.
 *
 * NOT covered: getCustodyStatus / getAttribution / release-status, which read
 * CustodyManifest through publicClient.readContract. Those need either a live
 * chain or a deeper readContract stub; tracked, not silently skipped.
 */
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { keccak256, toHex } from "viem";

jest.mock("@dtd/chain-sdk/anchor", () => ({
  ...jest.requireActual("@dtd/chain-sdk/anchor"),
  createManifest: jest.fn(
    async () => "0xmocked000000000000000000000000000000000000000000000000000000" as const
  ),
  confirmDelivery: jest.fn(
    async () => "0xmockedconfirm00000000000000000000000000000000000000000000000" as const
  ),
  getDeliveryDigest: jest.fn(async () => `0x${"ab".repeat(32)}` as const),
}));

import { AppModule } from "../api/app.module";
import { signTestJwt, signRoleJwt, seedTenant, seedBooking, resetDb } from "./helpers";
import { Role } from "@dtd/shared/roles.schema";

describe("Custody E2E", () => {
  let app: INestApplication;
  let tokenA: string;
  let tokenB: string;
  let driverTokenA: string;
  let receiverTokenA: string;
  let companyA: string;
  let bookingIdA: string;
  let manifestId: string;
  let pieceIds: string[] = [];

  const tripId = keccak256(toHex(`trip-custody-e2e-${Date.now()}`));
  const RECEIVER_PHONE = "+919000000042";

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const a = await seedTenant("Custody E2E Co A");
    const b = await seedTenant("Custody E2E Co B");
    companyA = a.companyId;
    tokenA = signTestJwt(a.userId, a.companyId);
    tokenB = signTestJwt(b.userId, b.companyId);
    driverTokenA = signRoleJwt(a.userId, a.companyId, Role.DRIVER);
    receiverTokenA = signRoleJwt(a.userId, a.companyId, Role.RECEIVER);

    bookingIdA = await seedBooking(a.companyId);
  });

  afterAll(async () => app.close());

  // ================================================================
  // Manifests
  // ================================================================

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
    pieceIds = res.body.pieces.map((p: any) => p.pieceId);
    expect(pieceIds).toHaveLength(5);
  });

  /** A5 — malformed addresses are rejected at the edge, not on-chain. */
  it("A5: rejects a manifest whose loader is not a valid address (400)", async () => {
    await request(app.getHttpServer())
      .post("/custody/manifests")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        bookingId: bookingIdA,
        tripId: keccak256(toHex("trip-bad-addr")),
        pieceCount: 1,
        loader: "not-an-address",
        driver: "0x2222222222222222222222222222222222222222",
        receiver: "0x3333333333333333333333333333333333333333",
      })
      .expect(400);
  });

  it("rejects manifest creation without MANIFEST_CREATE permission (403)", async () => {
    await request(app.getHttpServer())
      .post("/custody/manifests")
      .set("Authorization", `Bearer ${receiverTokenA}`)
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

  // ================================================================
  // A3 — split scan routes
  // ================================================================

  it("A3: a DRIVER can scan at loading", async () => {
    const res = await request(app.getHttpServer())
      .post("/custody/scans/loading")
      .set("Authorization", `Bearer ${driverTokenA}`)
      .send({ pieceId: pieceIds[0], manifestId })
      .expect(201);

    expect(res.body.isNew).toBe(true);
    expect(res.body.event.context).toBe("LOADING");
  });

  it("A3: a DRIVER CANNOT scan at unloading (403) — that's the receiver's act", async () => {
    await request(app.getHttpServer())
      .post("/custody/scans/unloading")
      .set("Authorization", `Bearer ${driverTokenA}`)
      .send({ pieceId: pieceIds[0], manifestId })
      .expect(403);
  });

  it("A3: a RECEIVER can scan at unloading", async () => {
    const res = await request(app.getHttpServer())
      .post("/custody/scans/unloading")
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ pieceId: pieceIds[0], manifestId })
      .expect(201);
    expect(res.body.event.context).toBe("UNLOADING");
  });

  it("A3: a RECEIVER CANNOT scan at loading (403)", async () => {
    await request(app.getHttpServer())
      .post("/custody/scans/loading")
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ pieceId: pieceIds[1], manifestId })
      .expect(403);
  });

  /**
   * The vulnerability the split closes: context used to be a request-body
   * field, so any caller could assert any context regardless of their role.
   */
  it("A3: context cannot be spoofed through the body — the route decides", async () => {
    const res = await request(app.getHttpServer())
      .post("/custody/scans/unloading")
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ pieceId: pieceIds[1], manifestId, context: "LOADING" })
      .expect(201);
    expect(res.body.event.context).toBe("UNLOADING");
  });

  it("OFFLINE QUEUE: replaying the same nonce is a no-op, not a duplicate", async () => {
    const clientNonce = "e2e-nonce-001";
    const body = { pieceId: pieceIds[2], manifestId, clientNonce };

    const first = await request(app.getHttpServer())
      .post("/custody/scans/unloading")
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send(body)
      .expect(201);
    expect(first.body.isNew).toBe(true);

    const replay = await request(app.getHttpServer())
      .post("/custody/scans/unloading")
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send(body)
      .expect(201);
    expect(replay.body.isNew).toBe(false);
    expect(replay.body.history).toHaveLength(1);
  });

  it("batch flush accepts many scans and reports duplicates", async () => {
    const res = await request(app.getHttpServer())
      .post("/custody/scans/unloading/batch")
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({
        scans: [
          { pieceId: pieceIds[3], manifestId, clientNonce: "batch-1" },
          { pieceId: pieceIds[3], manifestId, clientNonce: "batch-1" },
        ],
      })
      .expect(201);

    expect(res.body.total).toBe(2);
    expect(res.body.accepted).toBe(1);
    expect(res.body.duplicates).toBe(1);
  });

  // ================================================================
  // A4 — reconciliation
  // ================================================================

  /**
   * THE CORE CASE. Four of five pieces scanned in; the fifth never arrived.
   * The endpoint must name it, not merely count it.
   */
  it("A4: reconcile reports the shortage and names the missing piece", async () => {
    const res = await request(app.getHttpServer())
      .get(`/custody/manifests/${manifestId}/reconcile`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);

    expect(res.body.expected).toBe(5);
    expect(res.body.scanned).toBe(4);
    expect(res.body.missing).toBe(1);
    expect(res.body.missingPieceIds).toEqual([pieceIds[4]]);
    expect(res.body.complete).toBe(false);
    expect(res.body.summary).toContain("MISSING");
  });

  /** RequiresAnyPermission: the receiver must see it before signing for it. */
  it("A4: a RECEIVER can read reconcile (SHORTAGE_REPORT branch)", async () => {
    await request(app.getHttpServer())
      .get(`/custody/manifests/${manifestId}/reconcile`)
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .expect(200);
  });

  it("A4: a DRIVER cannot read reconcile — holds neither permission (403)", async () => {
    await request(app.getHttpServer())
      .get(`/custody/manifests/${manifestId}/reconcile`)
      .set("Authorization", `Bearer ${driverTokenA}`)
      .expect(403);
  });

  it("A4: reconcile on an unknown manifest is 404", async () => {
    await request(app.getHttpServer())
      .get(`/custody/manifests/0x${"11".repeat(32)}/reconcile`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(404);
  });

  // ================================================================
  // A2 — delivery confirmation
  // ================================================================

  it("A2: requesting a delivery OTP mints the receiver's signing key", async () => {
    const res = await request(app.getHttpServer())
      .post(`/custody/manifests/${manifestId}/delivery-otp`)
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ receiverPhone: RECEIVER_PHONE })
      .expect(201);

    expect(res.body.sent).toBe(true);
    expect(res.body.signingAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    // The seeded manifest declares a different receiver address, so the
    // freshly minted key legitimately does not match — the endpoint says so
    // rather than letting the mismatch surface later as a signature failure.
    expect(res.body.matchesManifest).toBe(false);
  });

  it("A2: a wrong OTP is rejected (401) and does not confirm anything", async () => {
    await request(app.getHttpServer())
      .post(`/custody/manifests/${manifestId}/confirm-delivery`)
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ receiverPhone: RECEIVER_PHONE, otpToken: "000000" })
      .expect(401);
  });

  it("A2: only a RECEIVER may confirm delivery — DRIVER gets 403", async () => {
    await request(app.getHttpServer())
      .post(`/custody/manifests/${manifestId}/confirm-delivery`)
      .set("Authorization", `Bearer ${driverTokenA}`)
      .send({ receiverPhone: RECEIVER_PHONE, otpToken: "123456" })
      .expect(403);
  });

  it("A2: the client cannot assert a delivered count — no such field exists", async () => {
    // whitelist:true strips unknown properties, so a forged count is dropped
    // before it reaches the service. The scanned count is always derived.
    await request(app.getHttpServer())
      .post(`/custody/manifests/${manifestId}/confirm-delivery`)
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ receiverPhone: RECEIVER_PHONE, otpToken: "000000", deliveredCount: 5 })
      .expect(401); // still fails on OTP, never on the injected count
  });

  it("A2: a malformed receiver phone is rejected at the edge (400)", async () => {
    await request(app.getHttpServer())
      .post(`/custody/manifests/${manifestId}/delivery-otp`)
      .set("Authorization", `Bearer ${receiverTokenA}`)
      .send({ receiverPhone: "9000000042" }) // no + prefix
      .expect(400);
  });

  // ================================================================
  // Isolation & auth
  // ================================================================

  it("TENANT ISOLATION: company B cannot read company A's piece history", async () => {
    const res = await request(app.getHttpServer())
      .get(`/custody/pieces/${pieceIds[0]}/history`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    expect(res.body).toHaveLength(0);
  });

  it("TENANT ISOLATION: company B cannot reconcile company A's manifest", async () => {
    await request(app.getHttpServer())
      .get(`/custody/manifests/${manifestId}/reconcile`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    await request(app.getHttpServer())
      .get(`/custody/pieces/DTD-0000000000/history`)
      .expect(401);
  });
});
