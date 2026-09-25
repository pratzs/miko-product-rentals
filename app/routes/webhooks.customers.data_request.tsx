import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { handleDataRequest, safeErr, type GdprCustomerPayload, type SendFn } from "../utils/gdpr.server";

/**
 * GDPR: customers/data_request. Shopify asks us to give the merchant every
 * piece of data we hold for this customer. We return 200 straight away and,
 * in the background, collect every RentalBooking (name, email, phone, dates,
 * amounts, notes) and EmailLog row for the customer and email them to the
 * merchant as a JSON attachment. An EmailLog audit row (type
 * "gdpr_data_request", no customer PII) is written either way.
 *
 * Never log the customer's email or the payload here: shop, topic and counts only.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  void (async () => {
    try {
      const key = process.env.RESEND_API_KEY;
      const send = key
        ? async (msg: Parameters<SendFn>[0]) => {
            const { Resend } = await import("resend");
            return new Resend(key).emails.send(msg);
          }
        : null;
      const result = await handleDataRequest(db, shop, payload as GdprCustomerPayload, send);
      console.log(
        `[webhook] ${topic} for ${shop}: ${result.bookings} booking(s), ${result.emailLogs} email log(s), export ${result.status}`,
      );
    } catch (err) {
      console.error(`[webhook] ${topic} for ${shop} failed: ${safeErr(err)}`);
    }
  })();

  return new Response(null, { status: 200 });
};
