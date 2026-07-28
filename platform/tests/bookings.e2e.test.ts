/**
 * E2E: quote -> booking -> assign -> cancel lifecycle + tenant isolation.
 * Runs against a real Postgres (docker-compose test db) and the Nest app.
 */
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../api/app.module";
import { signTestJwt, seedTenant, seedTruckAndDriver, resetDb } from "./helpers";

describe("Bookings E2E", () => {
  let app: INestApplication;
  let tokenA: string; // company A
  let tokenB: string; // company B (isolation check)
  let quoteId: string;

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const a = await seedTenant("Sharma Logistics");
    const b = await seedTenant("Verma Transport");
    tokenA = signTestJwt(a.userId, a.companyId);
    tokenB = signTestJwt(b.userId, b.companyId);
    await seedTruckAndDriver(a.companyId);
  });

  afterAll(async () => app.close());

  it("creates an instant estimate with a 30-min quote", async () => {
    const res = await request(app.getHttpServer())
      .post("/pricing/estimate")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        pickupLat: 28.61, pickupLng: 77.21,   // Delhi
        dropLat: 26.91, dropLng: 75.79,       // Jaipur
        truckType: "OPEN_14FT",
        materialWeightKg: 4000,
      })
      .expect(201);

    expect(res.body.estimated_price_inr).toBeGreaterThan(0);
    expect(res.body.range_low_inr).toBeLessThan(res.body.range_high_inr);
    quoteId = res.body.id;
  });

  it("creates a booking with multi-point stops + advance scheduling", async () => {
    const res = await request(app.getHttpServer())
      .post("/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        quoteId,
        truckType: "OPEN_14FT",
        materialWeightKg: 4000,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), // tomorrow
        stops: [
          { kind: "PICKUP", address: "Okhla Phase 2, Delhi", lat: 28.53, lng: 77.27, sequence: 0 },
          { kind: "PICKUP", address: "Gurugram Sec 18", lat: 28.49, lng: 77.07, sequence: 1 },
          { kind: "DROP", address: "VKI Area, Jaipur", lat: 26.99, lng: 75.78, sequence: 2 },
        ],
      })
      .expect(201);

    expect(res.body.status).toBe("CONFIRMED");
    expect(res.body.stops).toHaveLength(3);
    
    (global as any).bookingId = res.body.id;
  });

  it("rejects a booking scheduled in the past", async () => {
    await request(app.getHttpServer())
      .post("/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        quoteId,
        truckType: "OPEN_14FT",
        materialWeightKg: 4000,
        scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
        stops: [
          { kind: "PICKUP", address: "A", lat: 28.5, lng: 77.2, sequence: 0 },
          { kind: "DROP", address: "B", lat: 26.9, lng: 75.8, sequence: 1 },
        ],
      })
      .expect(400);
  });

  it("assigns an available truck + active driver", async () => {
    const trucks = await request(app.getHttpServer())
      .get("/fleet/trucks?status=AVAILABLE")
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    const drivers = await request(app.getHttpServer())
      .get("/fleet/drivers")
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/bookings/${(global as any).bookingId}/assign`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ truckId: trucks.body[0].id, driverId: drivers.body[0].id })
      .expect(201);

    expect(res.body.status).toBe("ASSIGNED");
  });

  it("TENANT ISOLATION: company B cannot see company A's booking", async () => {
    await request(app.getHttpServer())
      .get(`/bookings/${(global as any).bookingId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404); // RLS returns zero rows -> NotFound, never 403-with-data
  });

  it("cancels free of charge before transit", async () => {
    const res = await request(app.getHttpServer())
      .post(`/bookings/${(global as any).bookingId}/cancel`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ reason: "client postponed dispatch" })
      .expect(201);
    expect(res.body.status).toBe("CANCELLED");
  });
});