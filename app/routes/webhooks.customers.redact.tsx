import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

// GDPR: Anonymise personal data for a specific customer across all bookings.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const data = payload as any;
  const email = data.customer?.email as string | undefined;

  if (email) {
    await db.rentalBooking.updateMany({
      where: { shop, customerEmail: email },
      data: {
        customerName: "Redacted",
        customerEmail: "redacted@redacted.invalid",
      },
    });
  }

  return json({ ok: true });
};
