import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.SHOPIFY_BILLING_TEST !== "false";

  try {
    const billingCheck = await billing.check({
      plans: ["starter", "growth", "pro"],
      isTest,
    });
    if (billingCheck.hasActivePayment && billingCheck.appSubscriptions?.length) {
      await billing.cancel({
        subscriptionId: billingCheck.appSubscriptions[0].id,
        isTest,
        prorate: true,
      });
    }
  } catch {
    // Nothing active to cancel
  }

  await db.shopConfig.updateMany({ where: { shop }, data: { planName: "free" } });
  return json({ ok: true });
};
