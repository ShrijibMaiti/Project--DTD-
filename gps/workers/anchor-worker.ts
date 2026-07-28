/**
 * gps/workers/anchor-worker.ts
 * BullMQ job: close batch windows, anchor roots, survive chain reality.
 *
 * Chain writes fail in ways application code does not: gas spikes, nonce
 * races, RPC timeouts, and reorgs that unmake a "confirmed" transaction.
 * This worker assumes all of them happen.
 */

import { Queue, Worker, type Job } from "bullmq";
import type { Hex } from "viem";
import { anchorTripBatch, publicClient } from "@dtd/chain-sdk/anchor";
import { MerkleBatcher, BATCH_WINDOW_S, type Batch, type BatchStore } from "../batching/merkle-batcher";

export const ANCHOR_QUEUE = "dtd-gps-anchor";

interface AnchorJobData {
  tripId: string;
  root: Hex;
  fromTs: number;
  toTs: number;
  pingCount: number;
}

export interface AnchorMetrics {
  anchored(tripId: string, pingCount: number, latencyMs: number): void;
  failed(tripId: string, attempt: number, error: string): void;
  reorgDetected(tripId: string, txHash: string): void;
  lag(seconds: number): void;
}

/** Confirmations before we treat an anchor as final. */
const CONFIRMATIONS = 5;
const MAX_ATTEMPTS = 8;

export function createAnchorQueue(connection: any) {
  return new Queue<AnchorJobData>(ANCHOR_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 15_000 }, // 15s → ~32 min
      removeOnComplete: 1000,
      removeOnFail: false, // failures stay for inspection — this is evidence
    },
  });
}

/** Producer: hourly sweep that turns pending pings into anchor jobs. */
export class BatchScheduler {
  constructor(
    private batcher: MerkleBatcher,
    private queue: Queue<AnchorJobData>,
    private metrics: AnchorMetrics
  ) {}

  async run(now = Math.floor(Date.now() / 1000)): Promise<number> {
    const batches = await this.batcher.closeAllDue(now);
    for (const b of batches) {
      await this.queue.add(
        "anchor",
        {
          tripId: b.tripId,
          root: b.root,
          fromTs: b.fromTs,
          toTs: b.toTs,
          pingCount: b.pingCount,
        },
        // Idempotency: one job per (trip, window). A duplicate sweep is a no-op.
        { jobId: `${b.tripId}:${b.fromTs}:${b.toTs}` }
      );
      this.metrics.lag(now - b.toTs);
    }
    return batches.length;
  }
}

/** Consumer: performs the chain write and confirms it survived. */
export function createAnchorWorker(
  connection: any,
  store: BatchStore,
  metrics: AnchorMetrics
) {
  return new Worker<AnchorJobData>(
    ANCHOR_QUEUE,
    async (job: Job<AnchorJobData>) => {
      const { tripId, root, fromTs, toTs, pingCount } = job.data;
      const started = Date.now();

      try {
        const txHash = await anchorTripBatch(tripId as Hex, root, fromTs, toTs);

        // Wait for real finality, not just inclusion. A reorg after 1 block is
        // routine on L2s; treating inclusion as final would let an anchor
        // silently vanish while our DB claims it exists.
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: CONFIRMATIONS,
        });

        if (receipt.status !== "success") {
          throw new Error(`TX_REVERTED:${txHash}`);
        }

        const batchIndex = Number(receipt.logs?.[0]?.topics?.[2] ?? 0);
        await store.markAnchored(tripId, batchIndex, txHash);
        metrics.anchored(tripId, pingCount, Date.now() - started);

        return { txHash, batchIndex, blockNumber: Number(receipt.blockNumber) };
      } catch (err) {
        const msg = (err as Error).message;
        metrics.failed(tripId, job.attemptsMade + 1, msg);

        // TimeOverlap means this window was already anchored — a duplicate job,
        // not a failure. Swallow it rather than retrying forever.
        if (msg.includes("TimeOverlap")) {
          return { skipped: "ALREADY_ANCHORED" };
        }
        throw err; // let BullMQ back off and retry
      }
    },
    { connection, concurrency: 1 } // serial: one nonce, one signer, no races
  );
}

/**
 * Reorg auditor — run daily. Re-reads every anchor we believe is final and
 * confirms the chain still agrees. If a transaction vanished, our evidence
 * has a hole and we must re-anchor and say so, not discover it during a claim.
 */
export class ReorgAuditor {
  constructor(
    private store: BatchStore & {
      recentAnchors(sinceTs: number): Promise<Array<{ tripId: string; batchIndex: number; txHash: string }>>;
    },
    private queue: Queue<AnchorJobData>,
    private metrics: AnchorMetrics
  ) {}

  async audit(sinceTs: number): Promise<{ checked: number; missing: string[] }> {
    const anchors = await this.store.recentAnchors(sinceTs);
    const missing: string[] = [];

    for (const a of anchors) {
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: a.txHash as Hex,
        });
        if (receipt.status !== "success") {
          missing.push(a.txHash);
          this.metrics.reorgDetected(a.tripId, a.txHash);
        }
      } catch {
        // Transaction not found = it was reorged out.
        missing.push(a.txHash);
        this.metrics.reorgDetected(a.tripId, a.txHash);
      }
    }
    return { checked: anchors.length, missing };
  }
}

export { BATCH_WINDOW_S };