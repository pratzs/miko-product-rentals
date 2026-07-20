import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isRangeAvailable } from "../utils/availability";

/**
 * Backend for the Sidekick data extension (extensions/rentals-sidekick).
 *
 * Sidekick gives an app data tool ONE SECOND and silently stops invoking the
 * extension if that budget is missed repeatedly, with no error surfaced. Every
 * branch here is a Prisma read against an indexed column (or the availability
 * helper, which is also plain Prisma). Do NOT add an Admin GraphQL call: the
 * booking detail page does order/refund GraphQL and would blow the budget.
 * RentalBooking already denormalises order name, customer, totals and deposit
 * status at booking time, so none of that needs a live Shopify lookup.
 *
 * Read-only by contract. Anything that writes belongs in an action extension
 * where the merchant confirms first, and App Store rule 2.2.9 forbids
 * promotions or review requests on this surface.
 */

const MAX_ROWS = 10;

// Statuses that mean a rental is on the books and not finished.
const OPEN_STATUSES = ["pending", "confirmed", "active", "overdue"] as const;

function money(n: number | null | undefined): string | undefined {
  return typeof n === "number" ? n.toFixed(2) : undefined;
}

/** Start of the current month in UTC, for revenue aggregation. */
function startOfMonthUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Parse an ISO-ish date defensively; return null if unusable. */
function parseDate(raw: unknown): Date | null {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const shop = session.shop;
  const body = await request.json();
  const tool: string = body?.tool ?? "";
  const query: string = (body?.query ?? "").toString().trim();

  switch (tool) {
    /* ── Upcoming rentals that haven't started yet ──────────────────────── */
    case "list_upcoming_bookings": {
      const now = new Date();
      const bookings = await db.rentalBooking.findMany({
        where: { shop, startDate: { gte: now }, status: { in: ["pending", "confirmed", "active"] } },
        orderBy: { startDate: "asc" },
        take: MAX_ROWS,
      });
      const total = await db.rentalBooking.count({
        where: { shop, startDate: { gte: now }, status: { in: ["pending", "confirmed", "active"] } },
      });
      return cors(
        json({
          totalUpcoming: total,
          results: bookings.map((b) => ({
            type: "resource_link",
            uri: `gid://application/rental-booking/${b.id}`,
            name: `${b.shopifyOrderName || "Booking"} - ${b.customerName || b.customerEmail || "customer"}`,
            mimeType: "application/vnd.miko-rentals.booking",
            _meta: {
              order: b.shopifyOrderName || undefined,
              customer: b.customerName || b.customerEmail || undefined,
              startDate: b.startDate.toISOString(),
              endDate: b.endDate.toISOString(),
              units: b.unitsRented,
              status: b.status,
            },
          })),
        }),
      );
    }

    /* ── Items currently out with a customer ────────────────────────────── */
    case "list_active_rentals": {
      const now = new Date();
      const bookings = await db.rentalBooking.findMany({
        where: { shop, status: "active", startDate: { lte: now }, endDate: { gte: now } },
        orderBy: { endDate: "asc" },
        take: MAX_ROWS,
      });
      const total = await db.rentalBooking.count({
        where: { shop, status: "active", startDate: { lte: now }, endDate: { gte: now } },
      });
      return cors(
        json({
          totalActive: total,
          results: bookings.map((b) => ({
            type: "resource_link",
            uri: `gid://application/rental-booking/${b.id}`,
            name: `${b.customerName || b.customerEmail || "customer"} has ${b.shopifyOrderName || "a rental"} until ${b.endDate.toISOString().slice(0, 10)}`,
            mimeType: "application/vnd.miko-rentals.booking",
            _meta: {
              order: b.shopifyOrderName || undefined,
              customer: b.customerName || b.customerEmail || undefined,
              dueBack: b.endDate.toISOString(),
              units: b.unitsRented,
            },
          })),
        }),
      );
    }

    /* ── Overdue: past the due date and not returned ────────────────────── */
    case "list_overdue_rentals": {
      const now = new Date();
      const bookings = await db.rentalBooking.findMany({
        where: {
          shop,
          returnedAt: null,
          OR: [
            { status: "overdue" },
            { status: { in: ["confirmed", "active"] }, endDate: { lt: now } },
          ],
        },
        orderBy: { endDate: "asc" },
        take: MAX_ROWS,
      });
      const total = await db.rentalBooking.count({
        where: {
          shop,
          returnedAt: null,
          OR: [
            { status: "overdue" },
            { status: { in: ["confirmed", "active"] }, endDate: { lt: now } },
          ],
        },
      });
      return cors(
        json({
          totalOverdue: total,
          results: bookings.map((b) => ({
            type: "resource_link",
            uri: `gid://application/rental-booking/${b.id}`,
            name: `OVERDUE: ${b.customerName || b.customerEmail || "customer"} - ${b.shopifyOrderName || "rental"}`,
            mimeType: "application/vnd.miko-rentals.booking",
            _meta: {
              order: b.shopifyOrderName || undefined,
              customer: b.customerName || b.customerEmail || undefined,
              contact: b.customerEmail || b.customerPhone || undefined,
              wasDue: b.endDate.toISOString(),
              lateFeeCharged: money(b.lateFeeCharged),
            },
          })),
        }),
      );
    }

    /* ── All bookings for one customer ──────────────────────────────────── */
    case "find_customer_bookings": {
      if (!query) return cors(json({ results: [] }));
      const bookings = await db.rentalBooking.findMany({
        where: {
          shop,
          OR: [
            { customerEmail: { contains: query, mode: "insensitive" as const } },
            { customerName: { contains: query, mode: "insensitive" as const } },
          ],
        },
        orderBy: { startDate: "desc" },
        take: MAX_ROWS,
      });
      return cors(
        json({
          results: bookings.map((b) => ({
            type: "resource_link",
            uri: `gid://application/rental-booking/${b.id}`,
            name: `${b.shopifyOrderName || "Booking"} - ${b.status}`,
            mimeType: "application/vnd.miko-rentals.booking",
            _meta: {
              customer: b.customerName || b.customerEmail || undefined,
              startDate: b.startDate.toISOString(),
              endDate: b.endDate.toISOString(),
              status: b.status,
              totalCharged: money(b.totalCharged),
            },
          })),
        }),
      );
    }

    /* ── The catalogue of rentable products ─────────────────────────────── */
    case "list_rental_products": {
      const products = await db.rentalProduct.findMany({
        where: {
          shop,
          ...(query
            ? { shopifyProductTitle: { contains: query, mode: "insensitive" as const } }
            : {}),
        },
        orderBy: { shopifyProductTitle: "asc" },
        take: MAX_ROWS,
      });
      return cors(
        json({
          results: products.map((p) => ({
            type: "resource_link",
            uri: `gid://application/rental-product/${p.id}`,
            name: p.shopifyProductTitle || "Rental product",
            mimeType: "application/vnd.miko-rentals.product",
            _meta: {
              units: p.totalUnits,
              pricePerDay: money(p.pricePerDay),
              pricePerWeek: p.pricePerWeek ? money(p.pricePerWeek) : undefined,
              deposit: p.depositAmount ? money(p.depositAmount) : undefined,
              status: p.isActive ? "ACTIVE" : "INACTIVE",
            },
          })),
        }),
      );
    }

    /* ── This month's rental revenue and deposits held ──────────────────── */
    case "get_rental_revenue": {
      const from = startOfMonthUTC();
      const agg = await db.rentalBooking.aggregate({
        where: { shop, createdAt: { gte: from }, status: { notIn: ["cancelled", "pending"] } },
        _sum: { rentalPrice: true, totalCharged: true },
        _count: true,
      });
      const heldDeposits = await db.rentalBooking.aggregate({
        where: { shop, depositStatus: "held" },
        _sum: { depositAmount: true },
        _count: true,
      });
      return cors(
        json({
          results: [
            {
              type: "resource_link",
              uri: `gid://application/rental-revenue/${shop}`,
              name: `Rental revenue this month`,
              mimeType: "application/vnd.miko-rentals.revenue",
              _meta: {
                periodStart: from.toISOString().slice(0, 10),
                bookings: agg._count,
                rentalRevenue: money(agg._sum.rentalPrice ?? 0),
                totalCharged: money(agg._sum.totalCharged ?? 0),
                depositsHeld: money(heldDeposits._sum.depositAmount ?? 0),
                depositsHeldCount: heldDeposits._count,
              },
            },
          ],
        }),
      );
    }

    /* ── Is a product free for a date range? ────────────────────────────── */
    case "check_availability": {
      if (!query) return cors(json({ results: [] }));
      const product = await db.rentalProduct.findFirst({
        where: { shop, shopifyProductTitle: { contains: query, mode: "insensitive" as const } },
        orderBy: { shopifyProductTitle: "asc" },
      });
      if (!product) {
        return cors(json({ productFound: false, results: [] }));
      }

      // Default to the next 7 days when the merchant gives no range.
      const start = parseDate(body?.from) ?? new Date();
      const end =
        parseDate(body?.to) ?? new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      const units = Number(body?.units) > 0 ? Number(body.units) : 1;

      const result = await isRangeAvailable(
        shop,
        product.shopifyProductId,
        start,
        end,
        units,
      );

      return cors(
        json({
          productFound: true,
          results: [
            {
              type: "resource_link",
              uri: `gid://application/rental-availability/${product.id}`,
              name: `${product.shopifyProductTitle}: ${result.available ? "available" : "not available"} ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
              mimeType: "application/vnd.miko-rentals.availability",
              _meta: {
                product: product.shopifyProductTitle,
                from: start.toISOString().slice(0, 10),
                to: end.toISOString().slice(0, 10),
                available: result.available,
                unitsAvailable: result.unitsAvailable,
                totalUnits: result.totalUnits,
              },
            },
          ],
        }),
      );
    }

    default:
      return cors(json({ error: `Unknown tool: ${tool}` }, { status: 400 }));
  }
};

// Sidekick preflights the tool call before POSTing to it.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(json({ ok: true }));
};
