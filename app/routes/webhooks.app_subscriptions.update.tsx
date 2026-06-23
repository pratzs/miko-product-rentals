import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

/**
 * Handles app_subscriptions/update webhook.
 * Keeps the ShopConfig.planName in sync when Shopify billing changes.
 *
 * Payload shape (relevant fields):
 *   app_subscription.name  - the plan name string ("starter" | "growth" | "pro")
 *   app_subscription.status - "ACTIVE" | "CANCELLED" | "DECLINED" | "EXPIRED" | "FROZEN" | "PENDING"
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    return json({ ok: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscription = (payload as any)?.app_subscription;
  if (!subscription) return json({ ok: true });

  const name: string = (subscription.name ?? "").toLowerCase();
  const status: string = (subscription.status ?? "").toUpperCase();

  const validPlans = ["starter", "growth", "pro"];

  if (status === "ACTIVE" && validPlans.includes(name)) {
    // Stamp trialStartedAt on the very first subscription so reinstalls don't
    // get a fresh 14-day trial. We only set it if it's still null.
    const existing = await db.shopConfig.findUnique({
      where: { shop },
      select: { trialStartedAt: true },
    });
    await db.shopConfig.updateMany({
      where: { shop },
      data: {
        planName: name,
        subscriptionCancelledAt: null,
        ...(existing?.trialStartedAt ? {} : { trialStartedAt: new Date() }),
      },
    });
    console.info(`[billing] ${shop}: plan activated → ${name}`);
  } else if (status === "CANCELLED" && validPlans.includes(name)) {
    // With ApplyImmediately, upgrading a plan fires two webhooks in quick
    // succession: CANCELLED for the old plan, then ACTIVE for the new one.
    // If they arrive out of order (ACTIVE first), the DB already shows the
    // new plan — do NOT overwrite it. Only downgrade if the plan being
    // cancelled still matches what's stored.
    const updated = await db.shopConfig.updateMany({
      where: { shop, planName: name },
      data: { planName: "free", subscriptionCancelledAt: new Date() },
    });
    if (updated.count > 0) {
      console.info(`[billing] ${shop}: ${name} cancelled → reverted to free`);
    } else {
      console.info(`[billing] ${shop}: ${name} cancelled but plan already changed — skipping downgrade`);
    }
  } else if (status === "EXPIRED") {
    // EXPIRED is not caused by a plan replacement — always downgrade.
    await db.shopConfig.updateMany({
      where: { shop },
      data: { planName: "free", subscriptionCancelledAt: new Date() },
    });
    console.info(`[billing] ${shop}: subscription expired → reverted to free`);
  }

  return json({ ok: true });
};
