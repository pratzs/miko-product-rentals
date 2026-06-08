import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

// GDPR: Delete all data for a shop 48 hours after uninstall.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  await db.$transaction([
    db.emailLog.deleteMany({ where: { shop } }),
    db.rentalBooking.deleteMany({ where: { shop } }),
    db.rentalProduct.deleteMany({ where: { shop } }),
    db.blockedDate.deleteMany({ where: { shop } }),
    db.shopConfig.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  return json({ ok: true });
};
