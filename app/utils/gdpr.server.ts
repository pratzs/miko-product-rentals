// GDPR compliance-webhook logic (customers/data_request, customers/redact,
// shop/redact). Kept free of Remix/Shopify imports and takes the Prisma client
// as a parameter so tests/gdpr-webhooks.test.mjs can drive it with a mock.
//
// Logging rule: nothing in this file may log a customer's email, name, phone,
// address or the raw payload. Shop domain, topic, counts and numeric ids only.

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient;

export interface GdprCustomerPayload {
  customer?: { id?: number | string | null; email?: string | null; phone?: string | null } | null;
  orders_requested?: Array<number | string> | null;
  orders_to_redact?: Array<number | string> | null;
  data_request?: { id?: number | string | null } | null;
}

/**
 * Every form an order id can take in RentalBooking.shopifyOrderId. The order
 * webhooks store String(order.id) (numeric), but accept the GID form too in
 * case any row was written from the Admin GraphQL API.
 */
export function orderIdForms(ids: Array<number | string> | null | undefined): string[] {
  const out = new Set<string>();
  for (const raw of ids || []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const numeric = s.replace(/^gid:\/\/shopify\/Order\//, "");
    if (!/^\d+$/.test(numeric)) continue;
    out.add(numeric);
    out.add(`gid://shopify/Order/${numeric}`);
  }
  return [...out];
}

function cleanEmail(email: string | null | undefined): string {
  return typeof email === "string" ? email.trim() : "";
}

/**
 * RentalBooking rows that belong to this customer. RentalBooking does not
 * store a Shopify customer id, so we match on the email copied from the order
 * (case-insensitive) and on the order ids Shopify lists in the payload.
 * Returns null when there is nothing to match on, so callers never run an
 * unscoped query. Empty strings are never put into the OR (an
 * `customerEmail: ""` clause would match every booking with no email).
 */
export function bookingMatchWhere(
  shop: string,
  email: string,
  orderIds: string[],
): Prisma.RentalBookingWhereInput | null {
  const or: Prisma.RentalBookingWhereInput[] = [];
  if (email) or.push({ customerEmail: { equals: email, mode: "insensitive" } });
  if (orderIds.length > 0) or.push({ shopifyOrderId: { in: orderIds } });
  if (or.length === 0 || !shop) return null;
  return { shop, OR: or };
}

/** EmailLog rows for this customer: sent about one of their bookings, or to their address. */
export function emailLogMatchWhere(
  shop: string,
  email: string,
  bookingIds: string[],
): Prisma.EmailLogWhereInput | null {
  const or: Prisma.EmailLogWhereInput[] = [];
  if (bookingIds.length > 0) or.push({ bookingId: { in: bookingIds } });
  if (email) or.push({ recipientEmail: { equals: email, mode: "insensitive" } });
  if (or.length === 0 || !shop) return null;
  return { shop, OR: or };
}

export interface RedactResult {
  bookingsRedacted: number;
  emailLogsDeleted: number;
}

/**
 * customers/redact.
 *
 * RentalBooking rows are KEPT but every personal field is overwritten: the
 * merchant still needs the booking as a business record (units out on hire,
 * deposit and late-fee amounts, order reference for their accounts), and
 * deleting it would also free up calendar availability for stock that is
 * physically still with the customer. customerEmail and customerPhone become
 * "" rather than a placeholder address so the daily cron and orders/paid
 * (which skip bookings with no email) never try to email a redacted customer.
 * merchantNotes is cleared because it is free text the merchant typed about
 * this customer and routinely holds names, phone numbers and addresses.
 *
 * EmailLog rows are DELETED: each one is purely a record of a message sent to
 * this customer (recipient address + a subject that can contain their name),
 * with no value to the merchant once the customer is erased.
 */
export async function redactCustomer(
  db: Db,
  shop: string,
  payload: GdprCustomerPayload,
): Promise<RedactResult> {
  const email = cleanEmail(payload.customer?.email);
  const orderIds = orderIdForms(payload.orders_to_redact);
  const where = bookingMatchWhere(shop, email, orderIds);

  return db.$transaction(async (tx) => {
    const bookings = where
      ? await tx.rentalBooking.findMany({ where, select: { id: true } })
      : [];
    const bookingIds = bookings.map((b) => b.id);

    // Delete the email logs first, while we still know which bookings they
    // belong to and the address they went to.
    const logWhere = emailLogMatchWhere(shop, email, bookingIds);
    const logs = logWhere ? await tx.emailLog.deleteMany({ where: logWhere }) : { count: 0 };

    const redacted =
      bookingIds.length > 0
        ? await tx.rentalBooking.updateMany({
            where: { shop, id: { in: bookingIds } },
            data: {
              customerName: "Redacted",
              customerEmail: "",
              customerPhone: "",
              merchantNotes: "",
            },
          })
        : { count: 0 };

    return { bookingsRedacted: redacted.count, emailLogsDeleted: logs.count };
  });
}

/**
 * shop/redact: erase everything this app holds for the shop.
 *
 * Every model with a `shop` column is covered. Order respects the foreign
 * keys in prisma/schema.prisma:
 *   RentalBooking -> ShopConfig, RentalProduct, RentalVariant (no cascade)
 *   RentalVariant -> RentalProduct (cascade, deleted explicitly anyway)
 *   RentalProduct -> ShopConfig, BlockedDate -> ShopConfig
 *   EmailLog, EmailTemplate, Session have no FKs.
 */
export async function redactShop(db: Db, shop: string): Promise<Record<string, number>> {
  if (!shop) throw new Error("shop/redact called without a shop");
  const [emailLogs, emailTemplates, bookings, variants, products, blockedDates, configs, sessions] =
    await db.$transaction([
      db.emailLog.deleteMany({ where: { shop } }),
      db.emailTemplate.deleteMany({ where: { shop } }),
      db.rentalBooking.deleteMany({ where: { shop } }),
      db.rentalVariant.deleteMany({ where: { shop } }),
      db.rentalProduct.deleteMany({ where: { shop } }),
      db.blockedDate.deleteMany({ where: { shop } }),
      db.shopConfig.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  return {
    emailLogs: emailLogs.count,
    emailTemplates: emailTemplates.count,
    bookings: bookings.count,
    variants: variants.count,
    products: products.count,
    blockedDates: blockedDates.count,
    shopConfigs: configs.count,
    sessions: sessions.count,
  };
}

/** customers/data_request: every row we hold for this customer. */
export async function collectCustomerData(db: Db, shop: string, payload: GdprCustomerPayload) {
  const email = cleanEmail(payload.customer?.email);
  const orderIds = orderIdForms(payload.orders_requested);
  const where = bookingMatchWhere(shop, email, orderIds);

  const bookings = where
    ? await db.rentalBooking.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          rentalProduct: { select: { shopifyProductId: true, shopifyProductTitle: true } },
          rentalVariant: { select: { shopifyVariantId: true, shopifyVariantTitle: true } },
        },
      })
    : [];
  const logWhere = emailLogMatchWhere(shop, email, bookings.map((b) => b.id));
  const emailLogs = logWhere
    ? await db.emailLog.findMany({ where: logWhere, orderBy: { sentAt: "desc" } })
    : [];

  return { bookings, emailLogs };
}

/**
 * Who receives the export: the merchant's configured reply-to address, then
 * the store owner email captured at install, then the account owner's staff
 * session email.
 */
export async function merchantRecipient(db: Db, shop: string): Promise<string> {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { replyToEmail: true, merchantEmail: true },
  });
  if (config?.replyToEmail) return config.replyToEmail;
  if (config?.merchantEmail) return config.merchantEmail;
  const owner = await db.session.findFirst({
    where: { shop, accountOwner: true, email: { not: null } },
    select: { email: true },
  });
  return owner?.email || "";
}

export type SendFn = (msg: {
  from: string;
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: string }>;
}) => Promise<{ error?: { message: string } | null }>;

/**
 * Collect the customer's data and email it to the merchant as a JSON
 * attachment (miko-ai pattern). Whatever happens, an EmailLog row with
 * type "gdpr_data_request" is written as the audit trail. That row holds no
 * customer PII: bookingId "", the merchant's address, and a subject naming
 * only Shopify's numeric request/customer ids.
 */
export async function handleDataRequest(
  db: Db,
  shop: string,
  payload: GdprCustomerPayload,
  send: SendFn | null,
): Promise<{ status: "sent" | "failed" | "not_sent"; bookings: number; emailLogs: number }> {
  const { bookings, emailLogs } = await collectCustomerData(db, shop, payload);
  const recipient = await merchantRecipient(db, shop);
  const customerId = payload.customer?.id != null ? String(payload.customer.id) : "unknown";
  const requestId = payload.data_request?.id != null ? String(payload.data_request.id) : "unknown";
  const subject = `Customer data request from Shopify (request ${requestId}, customer ${customerId})`;

  let status: "sent" | "failed" | "not_sent" = "not_sent";
  if (recipient && send) {
    const exportData = {
      app: "Miko Rentals",
      shop,
      generatedAt: new Date().toISOString(),
      request: {
        dataRequestId: requestId,
        customerId,
        customerEmail: payload.customer?.email || null,
        ordersRequested: payload.orders_requested || [],
      },
      rentalBookings: bookings,
      emailsSentToCustomer: emailLogs,
    };
    const empty = bookings.length === 0 && emailLogs.length === 0;
    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;padding:24px">
        <h2>Customer data request</h2>
        <p>Shopify forwarded a customer data request for your store <strong>${escapeHtml(shop)}</strong>
        (request ${escapeHtml(requestId)}, Shopify customer ${escapeHtml(customerId)}).</p>
        ${
          empty
            ? "<p>Miko Rentals holds no records for this customer.</p>"
            : `<p>Miko Rentals holds <strong>${bookings.length}</strong> rental booking record(s) and
               <strong>${emailLogs.length}</strong> email log record(s) for this customer. The full data,
               including name, email and phone as copied from the order, is attached as a JSON file.</p>`
        }
        <p>Please pass this on to the customer within your compliance window (30 days under GDPR).</p>
        <hr><p style="font-size:12px;color:#6b7280">Miko Rentals is a Shopify app by Tripster Developers.</p>
      </div>`;
    try {
      const { error } = await send({
        from: `${process.env.MIKO_SENDER_NAME || "Miko Rentals"} <${process.env.MIKO_SENDER_EMAIL || "noreply@miko.co.nz"}>`,
        to: recipient,
        subject,
        html,
        attachments: empty
          ? undefined
          : [
              {
                filename: `miko-rentals-customer-data-${customerId}.json`,
                content: Buffer.from(JSON.stringify(exportData, null, 2), "utf-8").toString("base64"),
              },
            ],
      });
      status = error ? "failed" : "sent";
    } catch {
      status = "failed";
    }
  }

  await db.emailLog.create({
    data: {
      shop,
      bookingId: "",
      type: "gdpr_data_request",
      recipientEmail: recipient,
      subject,
      status,
    },
  });

  return { status, bookings: bookings.length, emailLogs: emailLogs.length };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Error summary safe to log: Prisma/Resend messages can echo query values. */
export function safeErr(err: unknown): string {
  const e = err as { name?: string; code?: string } | null;
  return `${e?.name || "Error"}${e?.code ? ` ${e.code}` : ""}`;
}
