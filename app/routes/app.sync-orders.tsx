import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncBookingsFromOrder } from "../utils/booking-from-order.server";

/**
 * Manual recovery: pull the last 50 orders from Shopify and create bookings
 * for any that have rental data and don't have a booking yet. Use this when
 * orders were placed before the orders/create webhook started firing, or
 * after webhook failures.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Note: we deliberately avoid the `customer` field because it requires the
  // `read_customers` scope, which would force a re-install of the app. The
  // billing/shipping addresses give us the name we need without that scope.
  const res = await admin.graphql(`
    #graphql
    query RecentOrdersForSync {
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          displayFinancialStatus
          email
          phone
          shippingAddress { firstName lastName phone }
          billingAddress { firstName lastName phone }
          lineItems(first: 50) {
            nodes {
              id
              customAttributes { key value }
            }
          }
        }
      }
    }
  `);
  const data = (await res.json()) as {
    data?: {
      orders?: {
        nodes: Array<{
          id: string;
          name: string;
          displayFinancialStatus: string;
          email: string | null;
          phone: string | null;
          shippingAddress: { firstName: string | null; lastName: string | null; phone: string | null } | null;
          billingAddress: { firstName: string | null; lastName: string | null; phone: string | null } | null;
          lineItems: { nodes: Array<{ id: string; customAttributes: Array<{ key: string; value: string }> }> };
        }>;
      };
    };
  };

  const totals = {
    bookingsCreated: 0,
    bookingsUpgraded: 0,
    bookingsFlaggedForReview: 0,
    skipped: 0,
    ordersScanned: 0,
  };

  for (const order of data.data?.orders?.nodes ?? []) {
    totals.ordersScanned++;
    const isPaid = ["PAID", "PARTIALLY_PAID"].includes(order.displayFinancialStatus);
    // Use billing/shipping address names instead of customer object (no scope needed).
    const addr = order.billingAddress || order.shippingAddress;
    const payload = {
      id: order.id.split("/").pop() || order.id,
      name: order.name,
      financial_status: order.displayFinancialStatus.toLowerCase(),
      email: order.email,
      phone: order.phone,
      customer: addr
        ? {
            first_name: addr.firstName || "",
            last_name: addr.lastName || "",
            email: order.email || "",
            phone: addr.phone || order.phone || "",
          }
        : undefined,
      shipping_address: order.shippingAddress ? { phone: order.shippingAddress.phone || "" } : undefined,
      billing_address: order.billingAddress ? { phone: order.billingAddress.phone || "" } : undefined,
      line_items: order.lineItems.nodes.map((li) => ({
        id: li.id.split("/").pop() || li.id,
        properties: li.customAttributes.map((a) => ({ name: a.key, value: a.value })),
      })),
    };
    const result = await syncBookingsFromOrder(shop, payload, { upgradeToConfirmed: isPaid });
    totals.bookingsCreated += result.bookingsCreated;
    totals.bookingsUpgraded += result.bookingsUpgraded;
    totals.bookingsFlaggedForReview += result.bookingsFlaggedForReview;
    totals.skipped += result.skipped;
  }

  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("returnTo") || "/app/bookings";
  return redirect(
    `${redirectTo}?synced=${totals.bookingsCreated}&upgraded=${totals.bookingsUpgraded}&flagged=${totals.bookingsFlaggedForReview}`,
  );
};

export const loader = async () => json({ ok: true });
