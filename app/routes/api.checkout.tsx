/**
 * Fallback checkout endpoint using the Shopify Admin API Draft Orders.
 *
 * The storefront /cart/add.js can reject rentals with "sold out" even when
 * inventoryPolicy is CONTINUE, because some products (3rd-party fulfilled,
 * app-managed locations) have a fulfillment service that performs its own
 * real-time availability check and overrides our policy settings.
 *
 * This endpoint creates a Draft Order via the Admin API, which bypasses ALL
 * inventory restrictions. The customer is redirected to the Shopify-hosted
 * Draft Order invoice page to complete payment — the checkout experience is
 * identical to regular checkout (same payment methods, shipping, etc.).
 *
 * When the customer pays, Shopify fires orders/create + orders/paid webhooks,
 * which our existing handlers pick up and create the booking as normal.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return json({ error: "POST only." }, { status: 405, headers: corsHeaders(request) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, { status: 400, headers: corsHeaders(request) });
  }

  const shop = typeof body.shop === "string" ? body.shop : null;
  const variantId = typeof body.variantId === "string" ? body.variantId : null;
  const productId = typeof body.productId === "string" ? body.productId : null;
  const startDate = typeof body.startDate === "string" ? body.startDate : null;
  const endDate = typeof body.endDate === "string" ? body.endDate : null;
  const units = typeof body.units === "number" ? body.units : 1;
  const perUnitPrice = typeof body.perUnitPrice === "number" ? body.perUnitPrice : 0;
  const rentalPrice = typeof body.rentalPrice === "number" ? body.rentalPrice : 0;
  const depositAmount = typeof body.depositAmount === "number" ? body.depositAmount : 0;
  const currency = typeof body.currency === "string" ? body.currency : "USD";

  // Pre-formatted display strings from the widget
  const startDisplay = typeof body.startDisplay === "string" ? body.startDisplay : startDate;
  const endDisplay = typeof body.endDisplay === "string" ? body.endDisplay : endDate;
  const durationDisplay = typeof body.durationDisplay === "string" ? body.durationDisplay : "";
  const rentalPriceDisplay = typeof body.rentalPriceDisplay === "string" ? body.rentalPriceDisplay : "";
  const depositDisplay = typeof body.depositDisplay === "string" ? body.depositDisplay : "None";

  if (!shop || !variantId || !startDate || !endDate) {
    return json(
      { error: "Missing required parameters: shop, variantId, startDate, endDate." },
      { status: 400, headers: corsHeaders(request) },
    );
  }

  // Retrieve the offline access token stored when the merchant installed the app.
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
    select: { accessToken: true },
  });
  if (!session?.accessToken) {
    return json(
      { error: "Store not found or not authenticated with Miko." },
      { status: 401, headers: corsHeaders(request) },
    );
  }

  const variantGid = variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;

  const numericProductId = String(productId || "").split("/").pop() || productId;

  // Compact _miko_data payload — same format as the storefront cart add.
  // When the customer pays the draft order, Shopify fires orders/create and
  // orders/paid webhooks. Our handler reads _miko_data from line item
  // properties (draft order customAttributes become order line item properties)
  // and creates the RentalBooking as normal.
  const mikoData = JSON.stringify({
    p: numericProductId,
    s: startDate,
    e: endDate,
    u: units,
    r: rentalPrice.toFixed(2),
    d: depositAmount.toFixed(2),
    pu: perUnitPrice.toFixed(2),
  });

  const query = `#graphql
    mutation CreateRentalDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
          status
        }
        userErrors { field message }
      }
    }`;

  const variables = {
    input: {
      lineItems: [
        {
          variantId: variantGid,
          quantity: units,
          // perUnitPrice × quantity = rentalPrice + depositAmount (the full amount
          // the customer owes). Without the Cart Transform Function, we set the
          // price explicitly here.
          originalUnitPrice: perUnitPrice.toFixed(2),
          requiresShipping: true,
          customAttributes: [
            { key: "Rental start", value: startDisplay || startDate },
            { key: "Return by", value: endDisplay || endDate },
            { key: "Rental duration", value: durationDisplay },
            { key: "Rental price", value: rentalPriceDisplay },
            { key: "Deposit", value: depositDisplay },
            { key: "_miko_data", value: mikoData },
          ],
        },
      ],
      tags: ["miko-rental"],
      note: `Rental booking: ${startDate} → ${endDate}`,
    },
  };

  try {
    const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = (await res.json()) as {
      data?: {
        draftOrderCreate?: {
          draftOrder?: { id: string; invoiceUrl: string; status: string };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
    };

    const draft = data.data?.draftOrderCreate?.draftOrder;
    const errors = data.data?.draftOrderCreate?.userErrors ?? [];

    if (errors.length > 0 || !draft?.invoiceUrl) {
      const msg = errors.map((e) => e.message).join(", ") || "Draft order creation failed.";
      console.error("[api/checkout] draftOrderCreate errors:", errors);
      return json({ error: msg }, { status: 500, headers: corsHeaders(request) });
    }

    return json({ checkoutUrl: draft.invoiceUrl }, { headers: corsHeaders(request) });
  } catch (err) {
    console.error("[api/checkout] Unexpected error:", err);
    return json({ error: "Could not create checkout. Please try again." }, {
      status: 500,
      headers: corsHeaders(request),
    });
  }
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}
