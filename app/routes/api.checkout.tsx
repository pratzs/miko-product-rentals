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
import { unauthenticated } from "../shopify.server";
import { quoteRental } from "../utils/rental-quote.server";
import { formatCurrency } from "../utils/pricing";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_ID = /^(gid:\/\/shopify\/ProductVariant\/)?\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Small in-memory sliding-window limiter. One process serves the app, so this
// is enough to stop one caller filling a shop's admin with draft orders.
const hits = new Map<string, number[]>();
function allowRequest(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= 3_600_000)) hits.delete(k);
    }
  }
  return true;
}

function clientIp(request: Request): string {
  return (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

function formatDateDisplay(isoDate: string): string {
  try {
    return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return isoDate;
  }
}

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

  // SECURITY (Nov 2026). This endpoint is public: the storefront calendar
  // calls it from the shopper's browser. It used to create a draft order on
  // whichever shop the body named, for whichever variant, at whichever price
  // the body gave. Now the caller chooses only WHAT to book (product, variant,
  // dates, units). Everything else is decided here:
  //   - the product must be an active rental of that shop, the dates must be
  //     allowed and free, and the price is the merchant's rate (quoteRental,
  //     the same code the calendar's quote uses),
  //   - the variant must belong to that product (checked with Shopify),
  //   - the text on the order line is written here, not taken from the caller,
  //   - requests are rate limited per caller and per shop.
  // Price, deposit, currency and display fields in the body are ignored.
  const shop = typeof body.shop === "string" ? body.shop.trim().toLowerCase() : null;
  const variantId =
    typeof body.variantId === "string" || typeof body.variantId === "number"
      ? String(body.variantId)
      : null;
  const productId = typeof body.productId === "string" ? body.productId : null;
  const startDate = typeof body.startDate === "string" ? body.startDate : null;
  const endDate = typeof body.endDate === "string" ? body.endDate : null;
  const requestedUnits =
    typeof body.units === "number" || typeof body.units === "string" ? body.units : 1;

  if (!shop || !variantId || !startDate || !endDate) {
    return json(
      { error: "Missing required parameters: shop, variantId, startDate, endDate." },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (
    !SHOP_DOMAIN.test(shop) ||
    !productId ||
    !PRODUCT_GID.test(productId) ||
    !VARIANT_ID.test(variantId) ||
    !ISO_DATE.test(startDate) ||
    !ISO_DATE.test(endDate)
  ) {
    return json(
      { error: "Missing required parameters: shop, variantId, startDate, endDate." },
      { status: 400, headers: corsHeaders(request) },
    );
  }

  if (!allowRequest(`${shop}|${clientIp(request)}`, 5, 60_000) || !allowRequest(shop, 120, 3_600_000)) {
    return json(
      { error: "Could not create checkout. Please try again." },
      { status: 429, headers: corsHeaders(request) },
    );
  }

  const variantGid = variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;

  // Server-side quote: rental must exist and be active for this shop, dates
  // inside the merchant's limits and still available, price from their rates.
  const quote = await quoteRental({
    shop,
    productId,
    startDate,
    endDate,
    units: requestedUnits,
    variantId: variantGid,
  });
  if (!quote.ok) {
    return json(quote.body, { status: quote.status, headers: corsHeaders(request) });
  }
  const { units, perUnitPrice, rentalPrice, depositAmount, rentalDays, currency } = quote.body;
  if (!(perUnitPrice > 0)) {
    return json(
      { error: "Could not create checkout. Please try again." },
      { status: 400, headers: corsHeaders(request) },
    );
  }

  // Admin client for the shop's own offline session (refreshes an expiring
  // token, unlike reading the Session table directly). A shop that is not
  // installed has no session and stops here.
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    return json(
      { error: "Store not found or not authenticated with Miko." },
      { status: 401, headers: corsHeaders(request) },
    );
  }

  // The variant must be a variant of the rental product that was quoted.
  // Without this a caller could name a cheap rental's product id together
  // with any other variant in the store and get that item at the rental rate.
  try {
    const ownerRes = await admin.graphql(
      `#graphql
        query RentalCheckoutVariantOwner($id: ID!) {
          productVariant(id: $id) { id product { id } }
        }`,
      { variables: { id: variantGid } },
    );
    const owner = (await ownerRes.json()) as {
      data?: { productVariant?: { product?: { id?: string } } | null };
    };
    if (owner.data?.productVariant?.product?.id !== productId) {
      return json(
        { error: "This variant is not available for rental." },
        { status: 404, headers: corsHeaders(request) },
      );
    }
  } catch (err) {
    console.error("[api/checkout] variant lookup failed:", err);
    return json(
      { error: "Could not create checkout. Please try again." },
      { status: 500, headers: corsHeaders(request) },
    );
  }

  const numericProductId = productId.split("/").pop() || productId;

  // Order line text, written here from the quote.
  const startDisplay = formatDateDisplay(startDate);
  const endDisplay = formatDateDisplay(endDate);
  const durationDisplay = `${rentalDays} day${rentalDays === 1 ? "" : "s"}`;
  const rentalPriceDisplay = formatCurrency(rentalPrice, currency);
  const depositDisplay = depositAmount > 0 ? formatCurrency(depositAmount, currency) : "None";

  // Compact _miko_data payload - same format as the storefront cart add.
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
          // the customer owes), from the server-side quote above. Without the
          // Cart Transform Function, we set the price explicitly here.
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
    const res = await admin.graphql(query, { variables });

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
