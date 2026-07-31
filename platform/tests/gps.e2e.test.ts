/**
 * E2E: device register -> start-trip -> HMAC ingest, plus timeline/proof
 * reads seeded directly against the signed archive (gps_pings) — ingest only
 * writes gps_pings_raw (see schema.sql's KNOWN GAP note: nothing bridges
 * raw -> signed yet), so timeline/proof tests seed gps_pings themselves,
 * same as gps/tests/stores.integration.test.ts already does.
 */
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { createHmac } from "crypto";
import { keccak256, toHex, type Hex } from "viem";
import { Pool } from "pg";

jest.mock("@dtd/chain-sdk/anchor", () => {
  const actual = jest.requireActual("@dtd/chain-sdk/anchor");
  return {
    ...actual,
    publicClient: {
      ...actual.publicClient,
      readContract: jest.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "getBatch") return { root: ("0x" + "ab".repeat(32)) as Hex };
        if (functionName === "verifyPing") return true;
        throw new Error(`unmocked readContract call: ${functionName}`);
      }),
    },
  };
});

import { AppModule } from "../api/app.module";
import { canonicalPing } from "@dtd/gps/ingest/gateway";
import {
  signTestJwt, signRoleJwt, seedTenant, seedTruckAndDriver, resetDb,
} from "./helpers";
import { Role } from "@dtd/shared/roles.schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seedSignedPing(companyId: string, p: {
  deviceId: string; truckId: string; tripId: string; lat: number; lng: number; ts: number;
}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.is_system', 'true', true)");
    await c.query(
      `INSERT INTO gps_pings
         (device_id, truck_id, trip_id, company_id, lat, lng, ts, received_at,
          signer_tier, signer_address, gateway_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,1,$8,$9)`,
      [
        p.deviceId, p.truckId, p.tripId, companyId, p.lat, p.lng, p.ts,
        "0x1111111111111111111111111111111111111111",
        ("0x" + "cd".repeat(65)) as Hex,
      ]
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function seedAnchoredBatch(companyId: string, tripId: string, fromTs: number, toTs: number) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.is_system', 'true', true)");
    await c.query(
      `INSERT INTO gps_batches (trip_id, company_id, root, from_ts, to_ts, ping_count, batch_index, chain_tx)
       VALUES ($1,$2,$3,$4,$5,3,0,'0xmocked')`,
      [tripId, companyId, ("0x" + "ab".repeat(32)), fromTs, toTs]
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

describe("GPS E2E", () => {
  let app: INestApplication;
  let tokenA: string;
  let tokenB: string;
  let companyA: string;
  let companyB: string;
  let truckA: string;
  const deviceId = "DEV-E2E-001";
  const sharedSecret = "e2e-shared-secret";
  const tripId = keccak256(toHex(`trip-gps-e2e-${Date.now()}`));

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const a = await seedTenant("GPS E2E Co A");
    const b = await seedTenant("GPS E2E Co B");
    companyA = a.companyId; companyB = b.companyId;
    tokenA = signTestJwt(a.userId, a.companyId);
    tokenB = signTestJwt(b.userId, b.companyId);
    const fleet = await seedTruckAndDriver(companyA);
    truckA = fleet.truckId;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("rejects device registration without FLEET_WRITE (403)", async () => {
    const dispatcherTenant = await seedTenant("GPS E2E Co C");
    const dispatcherToken = signRoleJwt(
      dispatcherTenant.userId, dispatcherTenant.companyId, Role.DRIVER
    );
    await request(app.getHttpServer())
      .post("/gps/devices")
      .set("Authorization", `Bearer ${dispatcherToken}`)
      .send({ deviceId: "DEV-SHOULD-FAIL", truckId: truckA, sharedSecret: "x" })
      .expect(403);
  });

  it("registers a device", async () => {
    const res = await request(app.getHttpServer())
      .post("/gps/devices")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ deviceId, truckId: truckA, sharedSecret })
      .expect(201);
    expect(res.body.status).toBe("ACTIVE");
  });

  it("starts a trip, binding the device to it", async () => {
    await request(app.getHttpServer())
      .post(`/gps/trucks/${truckA}/start-trip`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ tripId })
      .expect(201);
  });

  it("INGEST: accepts a correctly-HMAC'd ping with no bearer token (@Public + device auth)", async () => {
    const raw = { deviceId, lat: 28.6139, lng: 77.209, ts: Math.floor(Date.now() / 1000) };
    const deviceMac = createHmac("sha256", sharedSecret).update(canonicalPing(raw)).digest("hex");

    const res = await request(app.getHttpServer())
      .post("/gps/ingest")
      .send({ ...raw, deviceMac })
      .expect(201);

    expect(res.body.ok).toBe(true);
  });

  it("INGEST: rejects a forged MAC with ok:false, BAD_MAC — not a 401", async () => {
    const raw = { deviceId, lat: 28.61, lng: 77.2, ts: Math.floor(Date.now() / 1000) };
    const res = await request(app.getHttpServer())
      .post("/gps/ingest")
      .send({ ...raw, deviceMac: "deadbeef".repeat(8) })
      .expect(201); // domain-level rejection, not an HTTP auth failure

    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("BAD_MAC");
  });

  it("TIMELINE: builds from seeded signed pings", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedSignedPing(companyA, { deviceId, truckId: truckA, tripId, lat: 28.60, lng: 77.20, ts: now - 200 });
    await seedSignedPing(companyA, { deviceId, truckId: truckA, tripId, lat: 28.61, lng: 77.21, ts: now - 100 });
    await seedSignedPing(companyA, { deviceId, truckId: truckA, tripId, lat: 28.62, lng: 77.22, ts: now });
    await seedAnchoredBatch(companyA, tripId, now - 200, now);

    const res = await request(app.getHttpServer())
      .get(`/gps/trips/${tripId}/timeline`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);

    expect(res.body.tripId).toBe(tripId);
    expect(res.body.distanceKm).toBeGreaterThan(0);
  });

  it("returns 404 for a trip with no telemetry", async () => {
    const emptyTrip = keccak256(toHex("trip-with-nothing"));
    await request(app.getHttpServer())
      .get(`/gps/trips/${emptyTrip}/timeline`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(404);
  });

  it("PROOF: proveMoment returns a proof with the chain-mocked verification", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await request(app.getHttpServer())
      .get(`/gps/trips/${tripId}/proof`)
      .query({ ts: now })
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);

    expect(res.body.verifiedOnChain).toBe(true);
    expect(res.body.contractAddress).toBeDefined();
  });

  it("TENANT ISOLATION: company B cannot read company A's timeline", async () => {
    await request(app.getHttpServer())
      .get(`/gps/trips/${tripId}/timeline`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404); // RLS -> zero rows -> NotFound, same as bookings' isolation test
  });

  it("rejects an unauthenticated device-management request with 401", async () => {
    await request(app.getHttpServer())
      .post(`/gps/trucks/${truckA}/end-trip`)
      .expect(401);
  });
});