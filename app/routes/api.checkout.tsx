import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "../db.server";
import { unauthenticated } from "../shopify.server";
import { calculateRentalPrice } from "../utils/pricing";
import { isRangeAvailable } from "../utils/availability";
import { checkRentalLimit } from "../utils/plans";

/**
 * Public endpoint - no Shopify auth required.
 * Called from the storefront widget to create a draft order at the correct
 * rental price and return a checkout URL. This is the only way to override
 * line item prices in Shopify without Scripts or Functions.
 *
 * POST body (JSON):
 *   shop       - myshopify domain
 *   productId  - Shopify product GID (gid://shopify/Product/...)
 *   variantId  - Shopify variant numeric ID
 *   startDate  - ISO date string
 *   endDate    - ISO date string
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders(request) });
  }

  let body: {
    shop?: string;
    productId?: string;
    variantId?: string;
    startDate?: string;
    endDate?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, { status: 400, headers: corsHeaders(request) });
  }

  const { shop, productId, variantId, startDate: startDateStr, endDate: endDateStr } = body;

  if (!shop || !productId || !variantId || !startDateStr || !endDateStr) {
    return json(
      { error: "Missing required fields: shop, productId, variantId, startDate, endDate" },
      { status: 400, headers: corsHeaders(request) }
    );
  }

  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return json({ error: "Invalid date format." }, { status: 400, headers: corsHeaders(request) });
  }

  if (endDate <= startDate) {
    return json({ error: "End date must be after start date." }, { status: 400, headers: corsHeaders(request) });
  }

  const product = await db.rentalProduct.findFirst({
    where: { shop, shopifyProductId: productId, isActive: true },
  });

  if (!product) {
    return json(
      { error: "Product not found or not available for rental." },
      { status: 404, headers: corsHeaders(request) }
    );
  }

  const shopConfig = await db.shopConfig.findUnique({ where: { shop } });
  const planLimit = await checkRentalLimit(shop, shopConfig?.planName ?? "free", db);
  if (!planLimit.allowed) {
    return json(
      { error: "Online booking is temporarily unavailable for this item. Please contact us to arrange your rental." },
      { status: 403, headers: corsHeaders(request) }
    );
  }

  const available = await isRangeAvailable(shop, productId, startDate, endDate, 1);
  if (!available) {
    return json(
      { error: "These dates are not available. Please choose different dates." },
      { status: 409, headers: corsHeaders(request) }
    );
  }

  const pricing = calculateRentalPrice({
    startDate,
    endDate,
    pricePerDay: product.pricePerDay,
    pricePerWeek: product.pricePerWeek,
    pricePerMonth: product.pricePerMonth,
    depositAmount: product.depositAmount,
  });

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" });

  // Build the line items. The rental product is charged at the rental price
  // (not its regular Shopify price). The deposit is a separate custom line
  // item with no shipping or tax.
  const lineItems: {
    variantId?: string;
    title?: string;
    quantity: number;
    originalUnitPrice: string;
    requiresShipping?: boolean;
    taxable?: boolean;
    customAttributes?: { key: string; value: string }[];
  }[] = [
    {
      variantId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: 1,
      originalUnitPrice: pricing.rentalPrice.toFixed(2),
      customAttributes: [
        { key: "Rental start", value: fmt(startDate) },
        { key: "Return by", value: fmt(endDate) },
        { key: "Rental duration", value: `${pricing.rentalDays} day${pricing.rentalDays !== 1 ? "s" : ""}` },
        { key: "_miko_rental_product_id", value: product.id },
        { key: "_miko_start_date", value: startDateStr },
        { key: "_miko_end_date", value: endDateStr },
      ],
    },
  ];

  if (pricing.depositAmount > 0) {
    lineItems.push({
      title: "Security deposit (refundable on return)",
      quantity: 1,
      originalUnitPrice: pricing.depositAmount.toFixed(2),
      requiresShipping: false,
      taxable: false,
    });
  }

  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    return json(
      { error: "Shop is not connected. Please reinstall the app." },
      { status: 500, headers: corsHeaders(request) }
    );
  }

  const gqlResponse = await admin.graphql(
    `#graphql
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          lineItems,
          note: `Miko Rental: ${product.shopifyProductTitle}, ${fmt(startDate)} to ${fmt(endDate)}`,
          tags: ["miko-rental"],
        },
      },
    }
  );

  const result = await gqlResponse.json();
  const draftOrder = result.data?.draftOrderCreate?.draftOrder;
  const userErrors = result.data?.draftOrderCreate?.userErrors ?? [];

  if (userErrors.length > 0 || !draftOrder?.invoiceUrl) {
    console.error("[api/checkout] Draft order creation failed:", userErrors);
    return json(
      { error: "Could not create checkout. Please try again." },
      { status: 500, headers: corsHeaders(request) }
    );
  }

  return json({ checkoutUrl: draftOrder.invoiceUrl }, { headers: corsHeaders(request) });
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
