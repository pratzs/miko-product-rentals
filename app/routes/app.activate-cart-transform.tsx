import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ensureCartTransformActivated } from "../utils/cart-transform.server";

/**
 * Manual trigger to activate the Cart Transform Function on the current shop.
 * Visit /app/activate-cart-transform once after install (or after a function
 * redeploy on stores that installed before the auto-activation hook existed).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const result = await ensureCartTransformActivated(admin, session.shop);
  const ok = result.status === "activated" || result.status === "already-active";
  return json({ ok, shop: session.shop, result });
};
