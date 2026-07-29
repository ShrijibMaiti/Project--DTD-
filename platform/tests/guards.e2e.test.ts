/**
 * The wiring is only real when a wrong role and a wrong plan are both rejected.
 * Everything else in this file exists to make those two assertions trustworthy.
 */
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../api/app.module";
import { Role } from "@dtd/shared/roles.schema";
import { Plan } from "@dtd/shared/modules.schema";
import {
  resetDb, seedTenant, seedBooking, signTestJwt, signRoleJwt, signPlanJwt,
} from "./helpers";

describe("Guards E2E", () => {
  let app: INestApplication;
  let companyId: string;
  let userId: string;
  let bookingId: string;

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const t = await seedTenant("Guard Test Logistics");
    companyId = t.companyId;
    userId = t.userId;
    bookingId = await seedBooking(companyId);
  });

  afterAll(async () => app.close());

  // ---------------------------------------------------------------- 403: role

  it("THE 403: a DISPATCHER cannot add a truck (no FLEET_WRITE)", async () => {
    const res = await request(app.getHttpServer())
      .post("/fleet/trucks")
      .set("Authorization", `Bearer ${signRoleJwt(userId, companyId, Role.DISPATCHER)}`)
      .send({ regNumber: "WB12AB1234", truckType: "OPEN_14FT", capacityKg: 14000 });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("fleet:write");
  });

  it("a DISPATCHER CAN list trucks (has FLEET_READ)", async () => {
    await request(app.getHttpServer())
      .get("/fleet/trucks")
      .set("Authorization", `Bearer ${signRoleJwt(userId, companyId, Role.DISPATCHER)}`)
      .expect(200);
  });

  it("a COMPANY_ADMIN CAN add a truck", async () => {
    await request(app.getHttpServer())
      .post("/fleet/trucks")
      .set("Authorization", `Bearer ${signTestJwt(userId, companyId)}`)
      .send({ regNumber: "WB99XY8888", truckType: "OPEN_14FT", capacityKg: 14000 })
      .expect(201);
  });

  it("a DRIVER cannot list the company's trips (TRIP_READ_ALL is not his)", async () => {
    await request(app.getHttpServer())
      .get("/bookings")
      .set("Authorization", `Bearer ${signRoleJwt(userId, companyId, Role.DRIVER)}`)
      .expect(403);
  });

  it("a RECEIVER cannot generate documents", async () => {
    await request(app.getHttpServer())
      .post("/documents/generate")
      .set("Authorization", `Bearer ${signRoleJwt(userId, companyId, Role.RECEIVER)}`)
      .send({ bookingId, docType: "BILTY", payload: {} })
      .expect(403);
  });

  // ---------------------------------------------------------------- 402: plan

  it("THE 402: a STARTER customer hits a claims endpoint and is asked to upgrade", async () => {
    const res = await request(app.getHttpServer())
      .post(`/claims/packet/${bookingId}`)
      .set("Authorization", `Bearer ${signPlanJwt(userId, companyId, Plan.STARTER)}`);

    expect(res.status).toBe(402);
    expect(res.body.module).toBe("CLAIMS_EVIDENCE");
    expect(res.body.upgradeHint).toContain("upgrading");
  });

  it("402 not 403: an ADMIN with the permission but not the plan gets the sales answer", async () => {
    // COMPANY_ADMIN HAS CLAIMS_PACKET_BUILD. Only the module is missing.
    const res = await request(app.getHttpServer())
      .post(`/claims/packet/${bookingId}`)
      .set("Authorization", `Bearer ${signPlanJwt(userId, companyId, Plan.STANDARD)}`);
    expect(res.status).toBe(402);
  });

  it("a STARTER customer cannot reach documents either", async () => {
    await request(app.getHttpServer())
      .get(`/documents/booking/${bookingId}`)
      .set("Authorization", `Bearer ${signPlanJwt(userId, companyId, Plan.STARTER)}`)
      .expect(402);
  });

  it("a STARTER customer CAN reach fleet (FLEET is in Starter)", async () => {
    await request(app.getHttpServer())
      .get("/fleet/trucks")
      .set("Authorization", `Bearer ${signPlanJwt(userId, companyId, Plan.STARTER)}`)
      .expect(200);
  });

  it("an ENTERPRISE admin passes both gates", async () => {
    await request(app.getHttpServer())
      .post(`/claims/packet/${bookingId}`)
      .set("Authorization", `Bearer ${signTestJwt(userId, companyId)}`)
      .expect(201);
  });

  // ---------------------------------------------------------------- fail closed

  it("FAILS CLOSED: no token is 401 on every route", async () => {
    for (const path of ["/fleet/trucks", "/bookings", "/payments/" + bookingId]) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
  });

  it("a garbage token is 401, not 500", async () => {
    await request(app.getHttpServer())
      .get("/fleet/trucks")
      .set("Authorization", "Bearer not.a.token")
      .expect(401);
  });

  it("PUBLIC routes bypass the guard (401 here is the HMAC check, not the guard)", async () => {
    const res = await request(app.getHttpServer())
      .post("/payments/webhook/gateway")
      .set("x-razorpay-signature", "deadbeef")
      .send({ event: "payment.captured", payload: {} });

    // The guard would say NO_TOKEN; the signature check says BAD_WEBHOOK_SIGNATURE.
    // Asserting on the message, not the status, is what distinguishes them —
    // both paths return 401.
    expect(JSON.stringify(res.body)).not.toContain("NO_TOKEN");
    expect(JSON.stringify(res.body)).toContain("BAD_WEBHOOK_SIGNATURE");
  });
});