import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { redactCustomer, safeErr, type GdprCustomerPayload } from "../utils/gdpr.server";

/**
 * GDPR: customers/redact. Erases the customer's personal data: bookings
 * matched by email (case-insensitive) or orders_to_redact have name, email,
 * phone and merchant notes wiped, and every EmailLog row for them is deleted.
 * See redactCustomer() for why bookings are kept as anonymised records.
 *
 * On failure we return 500 so Shopify retries. Only shop, topic and counts are
 * logged, never the email or payload (Prisma errors can echo query values, so
 * only the error name/code is logged).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  try {
    const result = await redactCustomer(db, shop, payload as GdprCustomerPayload);
    console.log(
      `[webhook] ${topic} for ${shop}: ${result.bookingsRedacted} booking(s) anonymised, ${result.emailLogsDeleted} email log(s) deleted`,
    );
  } catch (err) {
    console.error(`[webhook] ${topic} for ${shop} failed: ${safeErr(err)}`);
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
};
