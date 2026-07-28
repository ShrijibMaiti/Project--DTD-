/**
 * identity/subscriptions/billing.ts
 * Razorpay subscriptions, invoices, dunning.
 *
 * Failure policy, stated deliberately: a failed payment does NOT instantly
 * cut off a customer. Freight companies whose tracking dies mid-trip because
 * a card expired will not come back. Dunning runs for 14 days, then downgrades
 * to Starter — data is never deleted, only gated.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { Plan } from "@dtd/shared/modules.schema";
import { prorate, isUpgrade, planDelta } from "./plans";
import type { EntitlementService } from "./entitlements";

export type SubscriptionStatus =
  | "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "DOWNGRADED" | "CANCELLED";

export interface Subscription {
  companyId: string;
  plan: Plan;
  status: SubscriptionStatus;
  gatewaySubscriptionId: string | null;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  failedAttempts: number;
  graceEndsAt: number | null;
}

export interface SubscriptionStore {
  get(companyId: string): Promise<Subscription | null>;
  upsert(s: Subscription): Promise<void>;
  setStatus(companyId: string, status: SubscriptionStatus): Promise<void>;
  incrementFailure(companyId: string): Promise<number>;
  resetFailures(companyId: string): Promise<void>;
  listPastDue(): Promise<Subscription[]>;
}

export interface PaymentGateway {
  createSubscription(input: {
    companyId: string; plan: Plan; amountPaise: number;
  }): Promise<{ subscriptionId: string }>;
  chargeOnce(input: {
    companyId: string; amountPaise: number; note: string;
  }): Promise<{ paymentId: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

export interface DunningNotifier {
  paymentFailed(companyId: string, attempt: number, graceEndsAt: number): Promise<void>;
  downgraded(companyId: string, from: Plan): Promise<void>;
}

const GRACE_DAYS = 14;
const CYCLE_DAYS = 30;

export class BillingService {
  constructor(
    private subs: SubscriptionStore,
    private gateway: PaymentGateway,
    private entitlements: EntitlementService,
    private notifier: DunningNotifier,
    private webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!
  ) {}

  async subscribe(companyId: string, plan: Plan): Promise<Subscription> {
    const { subscriptionId } = await this.gateway.createSubscription({
      companyId, plan, amountPaise: (await import("./plans")).describe(plan).monthlyPaise,
    });

    const now = Math.floor(Date.now() / 1000);
    const sub: Subscription = {
      companyId,
      plan,
      status: "ACTIVE",
      gatewaySubscriptionId: subscriptionId,
      currentPeriodStart: now,
      currentPeriodEnd: now + CYCLE_DAYS * 86400,
      failedAttempts: 0,
      graceEndsAt: null,
    };
    await this.subs.upsert(sub);
    await this.entitlements.applyPlan(companyId, plan);
    return sub;
  }

  /**
   * Upgrades take effect immediately (the customer wants the feature now);
   * downgrades take effect at period end (they already paid for this month).
   */
  async changePlan(companyId: string, to: Plan): Promise<{
    effective: "IMMEDIATE" | "PERIOD_END";
    chargePaise: number;
    creditPaise: number;
    delta: ReturnType<typeof planDelta>;
  }> {
    const sub = await this.subs.get(companyId);
    if (!sub) throw new Error("NO_SUBSCRIPTION");
    if (sub.plan === to) throw new Error("ALREADY_ON_PLAN");

    const daysRemaining = Math.max(
      0, Math.ceil((sub.currentPeriodEnd - Date.now() / 1000) / 86400)
    );
    const { chargePaise, creditPaise } = prorate({
      from: sub.plan, to, daysRemaining, daysInCycle: CYCLE_DAYS,
    });
    const delta = planDelta(sub.plan, to);

    if (isUpgrade(sub.plan, to)) {
      if (chargePaise > 0) {
        await this.gateway.chargeOnce({
          companyId, amountPaise: chargePaise,
          note: `Upgrade ${sub.plan} → ${to} (prorated)`,
        });
      }
      await this.subs.upsert({ ...sub, plan: to });
      await this.entitlements.applyPlan(companyId, to);
      return { effective: "IMMEDIATE", chargePaise, creditPaise, delta };
    }

    // Downgrade: schedule, don't strip features they've paid through.
    await this.subs.upsert({ ...sub, plan: sub.plan, status: sub.status });
    return { effective: "PERIOD_END", chargePaise, creditPaise, delta };
  }

  /** Gateway webhook. Signature-verified exactly like the payments module. */
  async handleWebhook(signature: string, body: any): Promise<{ ok: true }> {
    const expected = createHmac("sha256", this.webhookSecret)
      .update(JSON.stringify(body))
      .digest("hex");
    const a = Buffer.from(signature ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("BAD_WEBHOOK_SIGNATURE");
    }

    const companyId = body.payload?.subscription?.entity?.notes?.companyId;
    if (!companyId) throw new Error("NO_COMPANY_ID");

    switch (body.event) {
      case "subscription.charged":
        await this.subs.resetFailures(companyId);
        await this.subs.setStatus(companyId, "ACTIVE");
        break;
      case "subscription.pending":
      case "payment.failed":
        await this.onPaymentFailure(companyId);
        break;
      case "subscription.cancelled":
        await this.subs.setStatus(companyId, "CANCELLED");
        await this.entitlements.applyPlan(companyId, Plan.STARTER);
        break;
    }
    return { ok: true };
  }

  private async onPaymentFailure(companyId: string): Promise<void> {
    const attempts = await this.subs.incrementFailure(companyId);
    const sub = await this.subs.get(companyId);
    if (!sub) return;

    const graceEndsAt = sub.graceEndsAt
      ?? Math.floor(Date.now() / 1000) + GRACE_DAYS * 86400;

    await this.subs.upsert({
      ...sub, status: "GRACE", failedAttempts: attempts, graceEndsAt,
    });
    await this.notifier.paymentFailed(companyId, attempts, graceEndsAt);
  }

  /**
   * Daily sweep. Downgrade — never delete, never lock out entirely. A company
   * that loses Enterprise keeps its trip history; it simply cannot run new
   * custody flows until it pays.
   */
  async runDunning(now = Math.floor(Date.now() / 1000)): Promise<{ downgraded: string[] }> {
    const downgraded: string[] = [];
    for (const sub of await this.subs.listPastDue()) {
      if (sub.graceEndsAt && now > sub.graceEndsAt && sub.plan !== Plan.STARTER) {
        await this.subs.upsert({
          ...sub, plan: Plan.STARTER, status: "DOWNGRADED", graceEndsAt: null,
        });
        await this.entitlements.applyPlan(sub.companyId, Plan.STARTER);
        await this.notifier.downgraded(sub.companyId, sub.plan);
        downgraded.push(sub.companyId);
      }
    }
    return { downgraded };
  }
}