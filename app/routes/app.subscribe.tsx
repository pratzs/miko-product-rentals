import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { BillingReplacementBehavior } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";

/**
 * Subscribe endpoint - called via fetch() with Authorization: Bearer <idToken>.
 *
 * billing.request() throws a 401 Response whose
 * X-Shopify-API-Request-Failure-Reauthorize-Url header carries the Shopify
 * billing confirmation URL. The client reads this header and navigates
 * window.top to it. Do NOT add an ErrorBoundary here.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const plan = url.searchParams.get("plan");

  if (!plan || !["starter", "growth", "pro"].includes(plan)) {
    return redirect("/app/pricing");
  }

  const validPlan = plan as "starter" | "growth" | "pro";
  const shopHandle = session.shop.replace(".myshopify.com", "");
  const returnUrl = `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/pricing`;

  try {
    await billing.request({
      plan: validPlan,
      isTest: process.env.SHOPIFY_BILLING_TEST !== "false",
      returnUrl,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    });
  } catch (err: unknown) {
    // Billing errors contain a full response body - log everything so we can diagnose.
    const e = err as { errorData?: unknown; response?: { body?: unknown; code?: number }; message?: string };
    console.error("[billing] request failed for", session.shop, {
      errorData: e?.errorData,
      responseBody: e?.response?.body,
      responseCode: e?.response?.code,
      message: e?.message,
      raw: JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
    });
    throw err;
  }

  // billing.request always throws a redirect - this line is unreachable.
  return redirect("/app/pricing");
};
