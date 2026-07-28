import { ConflictException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { CreateTruckDto, CreateDriverDto } from "./fleet.dto";

@Injectable()
export class FleetService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  async addTruck(transporterId: string, userId: string, dto: CreateTruckDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const dup = await c.query(`SELECT id FROM trucks WHERE reg_number=$1`, [dto.regNumber]);
      if (dup.rows[0]) throw new ConflictException("TRUCK_ALREADY_REGISTERED");

      const { rows } = await c.query(
        `INSERT INTO trucks
           (company_id, reg_number, truck_type, capacity_kg, gps_device_id, status)
         VALUES ($1,$2,$3,$4,$5,'AVAILABLE') RETURNING *`,
        [transporterId, dto.regNumber, dto.truckType, dto.capacityKg, dto.gpsDeviceId ?? null]
      );
      await this.audit.record({
        transporterId, userId,
        action: "TRUCK_ADDED", entity: "truck", entityId: rows[0].id,
      });
      return rows[0];
    });
  }

  async listTrucks(transporterId: string, status?: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = status
        ? await c.query(`SELECT * FROM trucks WHERE status=$1 ORDER BY created_at DESC`, [status])
        : await c.query(`SELECT * FROM trucks ORDER BY created_at DESC`);
      return rows;
    });
  }

  async setTruckStatus(transporterId: string, id: string, status: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `UPDATE trucks SET status=$2 WHERE id=$1 RETURNING id, status`, [id, status]
      );
      return rows[0];
    });
  }

  async addDriver(transporterId: string, userId: string, dto: CreateDriverDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const dup = await c.query(`SELECT id FROM drivers WHERE phone=$1`, [dto.phone]);
      if (dup.rows[0]) throw new ConflictException("DRIVER_PHONE_EXISTS");

      // NOTE: on first custody signature, Domain 2's SignerService.ensureKey(phone)
      // will mint this driver's signing key; the address lands in signing_address.
      const { rows } = await c.query(
        `INSERT INTO drivers
           (company_id, full_name, phone, license_number, status)
         VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING *`,
        [transporterId, dto.fullName, dto.phone, dto.licenseNumber]
      );
      await this.audit.record({
        transporterId, userId,
        action: "DRIVER_ADDED", entity: "driver", entityId: rows[0].id,
      });
      return rows[0];
    });
  }

  async listDrivers(transporterId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(`SELECT * FROM drivers ORDER BY created_at DESC`);
      return rows;
    });
  }

  async availability(transporterId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const trucks = await c.query(
        `SELECT truck_type, count(*) FILTER (WHERE status='AVAILABLE') AS available,
                count(*) AS total
         FROM trucks GROUP BY truck_type`
      );
      const drivers = await c.query(
        `SELECT count(*) FILTER (WHERE status='ACTIVE') AS active FROM drivers`
      );
      return { trucks: trucks.rows, activeDrivers: Number(drivers.rows[0].active) };
    });
  }
}