/**
 * This route is no longer used. Checkout is now handled via the standard
 * Shopify cart (/cart/add.js) combined with the miko-cart-transform
 * Cart Transform Function, which overrides the price at checkout.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return json({ error: "This endpoint is no longer in use." }, { status: 410 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return json({ error: "This endpoint is no longer in use." }, { status: 410 });
};
