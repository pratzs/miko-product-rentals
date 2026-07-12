import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

/**
 * GDPR: Shopify asks us to make the customer's stored data available to the
 * merchant within the compliance window. We locate every RentalBooking row
 * for this customer and email a plain-text summary to the merchant's own
 * contact address so they can forward it on -- rather than a no-op that
 * relies on someone remembering to handle this "out of band".
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const data = payload as { customer?: { email?: string } };
  const email = data.customer?.email;

  try {
    if (email) {
      const bookings = await db.rentalBooking.findMany({
        where: { shop, customerEmail: email },
        orderBy: { createdAt: "desc" },
      });

      const config = await db.shopConfig.findUnique({ where: { shop } });
      const notifyTo = config?.replyToEmail;

      if (notifyTo && bookings.length > 0) {
        const { Resend } = await import("resend");
        const key = process.env.RESEND_API_KEY;
        if (key) {
          const resend = new Resend(key);
          const lines = bookings.map((b) =>
            `Order ${b.shopifyOrderName || b.shopifyOrderId || "(no order)"}: ` +
            `${b.customerName || "unknown name"} <${b.customerEmail}>, phone ${b.customerPhone || "n/a"}, ` +
            `rental ${b.startDate.toISOString().slice(0, 10)} to ${b.endDate.toISOString().slice(0, 10)}, ` +
            `status ${b.status}, deposit status ${b.depositStatus}.`,
          );
          await resend.emails.send({
            from: "Miko Rentals <onboarding@resend.dev>",
            to: notifyTo,
            subject: `Customer data request: ${email}`,
            text:
              `Shopify sent a data request for ${email}. Here is every rental booking record we store ` +
              `for this customer, so you can respond within your compliance window:\n\n${lines.join("\n")}`,
          });
        } else {
          console.error(`[webhook] customers/data_request: RESEND_API_KEY not set, cannot notify ${shop} about request for ${email}`);
        }
      } else {
        console.log(`[webhook] customers/data_request: ${bookings.length} booking(s) found for ${email} at ${shop}, no reply-to email configured to notify`);
      }
    }
  } catch (error) {
    console.error("[webhook] customers/data_request error:", error);
  }

  return json({ ok: true });
};
