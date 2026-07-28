/**
 * E2E: the money paths. Most important suite — real money.
 *   1. collection lifecycle + webhook signature verification (reject forged)
 *   2. idempotent capture (double webhook != double payment)
 *   3. release-gate: payout NEVER releases when the chain says Short
 */
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { createHmac } from "crypto";
import { AppModule } from "../api/app.module";
import {
  signTestJwt, seedTenant, seedBooking, resetDb, mockChainIsReleasable,
} from "./helpers";

describe("Payments E2E", () => {
  let app: INestApplication;
  let token: string;
  let transporterId: string;
  let bookingId: string;
  let orderId: string;

  const webhookSig = (body: unknown) =>
    createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(JSON.stringify(body))
      .digest("hex");

  const internalSig = (body: unknown) =>
    createHmac("sha256", process.env.DTD_INTERNAL_WEBHOOK_SECRET!)
      .update(JSON.stringify(body))
      .digest("hex");

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const t = await seedTenant("Sharma Logistics");
    transporterId = t.transporterId;
    token = signTestJwt(t.userId, t.transporterId);
    bookingId = await seedBooking(t.transporterId);
  });

  afterAll(async () => app.close());

  it("creates a UPI collection when the vehicle reaches loading point", async () => {
    const res = await request(app.getHttpServer())
      .post("/payments/collect")
      .set("Authorization", `Bearer ${token}`)
      .send({ bookingId, amountInr: 42000, method: "UPI" })
      .expect(201);

    expect(res.body.status).toBe("PENDING");
    expect(res.body.payout_status).toBe("HELD");
    orderId = res.body.gateway_order_id;
  });

  it("rejects duplicate collections for the same booking", async () => {
    await request(app.getHttpServer())
      .post("/payments/collect")
      .set("Authorization", `Bearer ${token}`)
      .send({ bookingId, amountInr: 42000, method: "UPI" })
      .expect(400);
  });

  it("REJECTS a webhook with a forged signature", async () => {
    const body = {
      event: "payment.captured",
      payload: { payment: { entity: { order_id: orderId } } },
    };
    await request(app.getHttpServer())
      .post("/payments/webhook/gateway")
      .set("x-razorpay-signature", "deadbeef".repeat(8))
      .send(body)
      .expect(401);

    const p = await request(app.getHttpServer())
      .get(`/payments/${bookingId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(p.body.status).toBe("PENDING"); // untouched
  });

  it("marks PAID on a correctly signed capture webhook", async () => {
    const body = {
      event: "payment.captured",
      payload: { payment: { entity: { order_id: orderId } } },
    };
    await request(app.getHttpServer())
      .post("/payments/webhook/gateway")
      .set("x-razorpay-signature", webhookSig(body))
      .send(body)
      .expect(201);

    const p = await request(app.getHttpServer())
      .get(`/payments/${bookingId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(p.body.status).toBe("PAID");
    expect(p.body.payout_status).toBe("HELD"); // paid in, NOT paid out
  });

  it("is idempotent: replaying the same webhook changes nothing", async () => {
    const body = {
      event: "payment.captured",
      payload: { payment: { entity: { order_id: orderId } } },
    };
    await request(app.getHttpServer())
      .post("/payments/webhook/gateway")
      .set("x-razorpay-signature", webhookSig(body))
      .send(body)
      .expect(201);

    const p = await request(app.getHttpServer())
      .get(`/payments/${bookingId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(p.body.status).toBe("PAID"); // still exactly one PAID row
  });

  it("THE MONEY GATE: payout stays HELD when chain says Short (175/200)", async () => {
    mockChainIsReleasable(false); // CustodyManifest.isReleasable() -> false

    const body = { manifestId: "0x" + "ab".repeat(32), bookingId, transporterId };
    await request(app.getHttpServer())
      .post("/payments/webhook/release-gate")
      .set("x-dtd-internal-signature", internalSig(body))
      .send(body)
      .expect(400); // CHAIN_SAYS_NOT_RELEASABLE

    const p = await request(app.getHttpServer())
      .get(`/payments/${bookingId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(p.body.payout_status).toBe("HELD"); // 25 missing pieces -> money frozen
  });

  it("releases payout when chain confirms full scan match (200/200)", async () => {
    mockChainIsReleasable(true);

    const body = { manifestId: "0x" + "ab".repeat(32), bookingId, transporterId };
    await request(app.getHttpServer())
      .post("/payments/webhook/release-gate")
      .set("x-dtd-internal-signature", internalSig(body))
      .send(body)
      .expect(201);

    const p = await request(app.getHttpServer())
      .get(`/payments/${bookingId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(p.body.payout_status).toBe("RELEASED");
  });

  it("rejects a release-gate call with a forged internal signature", async () => {
    const body = { manifestId: "0x" + "cd".repeat(32), bookingId, transporterId };
    await request(app.getHttpServer())
      .post("/payments/webhook/release-gate")
      .set("x-dtd-internal-signature", "f00d".repeat(16))
      .send(body)
      .expect(401);
  });
});