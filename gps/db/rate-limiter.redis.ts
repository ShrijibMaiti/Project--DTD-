/**
 * Redis-backed RateLimiter for IngestGateway.
 *
 * Confirmed via repo search: no existing ioredis/REDIS_URL pattern exists
 * anywhere else in the codebase (anchor-worker.ts's `connection: any` is
 * passed in externally, untyped). This is a fresh, standard client reading
 * REDIS_URL — the conventional default, matching how bullmq's Queue/Worker
 * typically connect.
 *
 * Fixed window, per device. Simple and correct for "one ping every few
 * seconds per device" traffic; nothing in the domain implies sliding-window
 * precision is required.
 */

import Redis from "ioredis";
import type { RateLimiter } from "../ingest/gateway";

const WINDOW_S = 10;
const MAX_PER_WINDOW = 20; // generous: real devices ping every 5-30s

export class RedisRateLimiter implements RateLimiter {
  private redis: Redis;

  constructor(redisUrl: string = process.env.REDIS_URL ?? "redis://localhost:6379") {
    this.redis = new Redis(redisUrl);
  }

  async allow(deviceId: string): Promise<boolean> {
    const key = `gps:ratelimit:${deviceId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_S);
    }
    return count <= MAX_PER_WINDOW;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
