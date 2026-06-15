import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// GDPR: Shopify may ask for all customer data we store.
// We respond with 200 OK - actual data provision happens out-of-band via support.
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  return json({ ok: true });
};
