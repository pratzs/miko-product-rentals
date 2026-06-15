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
    await db.shopConfig.updateMany({ where: { shop }, data: { planName: name } });
    console.info(`[billing] ${shop}: plan activated → ${name}`);
  } else if (["CANCELLED", "DECLINED", "EXPIRED"].includes(status)) {
    await db.shopConfig.updateMany({ where: { shop }, data: { planName: "free" } });
    console.info(`[billing] ${shop}: subscription ${status.toLowerCase()} → reverted to free`);
  }

  return json({ ok: true });
};
