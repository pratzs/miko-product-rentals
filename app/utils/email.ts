import { Resend } from "resend";
import { db } from "~/db.server";
import { format } from "date-fns";
import { formatCurrency } from "./pricing";

function getResend(apiKey: string) {
  return new Resend(apiKey);
}

interface BookingEmailData {
  shop: string;
  bookingId: string;
  customerName: string;
  customerEmail: string;
  productTitle: string;
  startDate: Date;
  endDate: Date;
  rentalDays: number;
  rentalPrice: number;
  depositAmount: number;
  totalCharged: number;
  orderName: string;
  currency: string;
}

async function getShopEmailConfig(shop: string) {
  const config = await db.shopConfig.findUnique({ where: { shop } });
  if (!config || !config.resendApiKey) return null;
  return config;
}

async function logEmail(
  shop: string,
  bookingId: string,
  type: string,
  recipientEmail: string,
  subject: string,
  status: "sent" | "failed",
) {
  await db.emailLog.create({
    data: { shop, bookingId, type, recipientEmail, subject, status },
  });
}

export async function sendBookingConfirmation(data: BookingEmailData) {
  const config = await getShopEmailConfig(data.shop);
  if (!config) return;

  const resend = getResend(config.resendApiKey);
  const subject = `Your rental booking is confirmed — ${data.productTitle}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <div style="background: #0f172a; padding: 28px 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px; font-weight: 600;">Booking Confirmed</h1>
        <p style="color: #94a3b8; margin: 4px 0 0; font-size: 14px;">Order ${data.orderName}</p>
      </div>
      <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
        <p style="margin: 0 0 24px; font-size: 15px;">Hi ${data.customerName},</p>
        <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6;">
          Your rental for <strong>${data.productTitle}</strong> is confirmed. Here are your details:
        </p>

        <div style="background: white; border-radius: 8px; border: 1px solid #e2e8f0; padding: 20px; margin-bottom: 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Rental starts</td>
              <td style="padding: 8px 0; text-align: right; font-size: 14px; font-weight: 500;">${format(data.startDate, "EEEE, d MMMM yyyy")}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Returns by</td>
              <td style="padding: 8px 0; text-align: right; font-size: 14px; font-weight: 500;">${format(data.endDate, "EEEE, d MMMM yyyy")}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Duration</td>
              <td style="padding: 8px 0; text-align: right; font-size: 14px;">${data.rentalDays} day${data.rentalDays > 1 ? "s" : ""}</td>
            </tr>
            <tr style="border-top: 1px solid #e2e8f0;">
              <td style="padding: 12px 0 8px; color: #64748b; font-size: 14px;">Rental fee</td>
              <td style="padding: 12px 0 8px; text-align: right; font-size: 14px;">${formatCurrency(data.rentalPrice, data.currency)}</td>
            </tr>
            ${data.depositAmount > 0 ? `
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Deposit (refundable)</td>
              <td style="padding: 8px 0; text-align: right; font-size: 14px;">${formatCurrency(data.depositAmount, data.currency)}</td>
            </tr>` : ""}
            <tr style="border-top: 1px solid #e2e8f0;">
              <td style="padding: 12px 0 0; font-weight: 600; font-size: 15px;">Total charged</td>
              <td style="padding: 12px 0 0; text-align: right; font-weight: 600; font-size: 15px;">${formatCurrency(data.totalCharged, data.currency)}</td>
            </tr>
          </table>
        </div>

        ${data.depositAmount > 0 ? `
        <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="margin: 0; font-size: 14px; color: #1d4ed8;">
            <strong>About your deposit:</strong> The ${formatCurrency(data.depositAmount, data.currency)} deposit will be returned to you once the item is received back in good condition.
          </p>
        </div>` : ""}

        <p style="margin: 0 0 8px; font-size: 14px; color: #64748b;">Questions? Reply to this email or contact us at <a href="mailto:${config.supportEmail}" style="color: #0f172a;">${config.supportEmail || config.senderEmail}</a></p>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: `${config.senderName} <${config.senderEmail}>`,
      to: data.customerEmail,
      subject,
      html,
    });
    await logEmail(data.shop, data.bookingId, "confirmation", data.customerEmail, subject, "sent");
  } catch {
    await logEmail(data.shop, data.bookingId, "confirmation", data.customerEmail, subject, "failed");
  }
}

export async function sendReturnReminder(
  shop: string,
  bookingId: string,
  customerName: string,
  customerEmail: string,
  productTitle: string,
  endDate: Date,
  currency: string,
) {
  const config = await getShopEmailConfig(shop);
  if (!config) return;

  const resend = getResend(config.resendApiKey);
  const subject = `Reminder: Your rental of ${productTitle} is due back tomorrow`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <div style="background: #f59e0b; padding: 28px 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px; font-weight: 600;">Return Reminder</h1>
      </div>
      <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
        <p style="margin: 0 0 16px; font-size: 15px;">Hi ${customerName},</p>
        <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">
          Just a friendly reminder that your rental of <strong>${productTitle}</strong> is due back by <strong>${format(endDate, "EEEE, d MMMM yyyy")}</strong>.
        </p>
        <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6;">
          Please ensure the item is returned on time to avoid any late fees.
        </p>
        <p style="margin: 0; font-size: 14px; color: #64748b;">Questions? Contact us at <a href="mailto:${config.supportEmail || config.senderEmail}" style="color: #0f172a;">${config.supportEmail || config.senderEmail}</a></p>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: `${config.senderName} <${config.senderEmail}>`,
      to: customerEmail,
      subject,
      html,
    });
    await logEmail(shop, bookingId, "return_reminder", customerEmail, subject, "sent");
  } catch {
    await logEmail(shop, bookingId, "return_reminder", customerEmail, subject, "failed");
  }
}

export async function sendOverdueNotice(
  shop: string,
  bookingId: string,
  customerName: string,
  customerEmail: string,
  productTitle: string,
  endDate: Date,
  lateFeePerDay: number,
  currency: string,
) {
  const config = await getShopEmailConfig(shop);
  if (!config) return;

  const resend = getResend(config.resendApiKey);
  const subject = `Action needed: ${productTitle} rental is overdue`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <div style="background: #dc2626; padding: 28px 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px; font-weight: 600;">Rental Overdue</h1>
      </div>
      <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
        <p style="margin: 0 0 16px; font-size: 15px;">Hi ${customerName},</p>
        <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">
          Your rental of <strong>${productTitle}</strong> was due back on <strong>${format(endDate, "EEEE, d MMMM yyyy")}</strong> and has not yet been returned.
        </p>
        ${lateFeePerDay > 0 ? `
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="margin: 0; font-size: 14px; color: #dc2626;">
            A late fee of <strong>${formatCurrency(lateFeePerDay, currency)} per day</strong> is being applied until the item is returned.
          </p>
        </div>` : ""}
        <p style="margin: 0 0 24px; font-size: 15px;">Please return the item as soon as possible or contact us to arrange collection.</p>
        <p style="margin: 0; font-size: 14px; color: #64748b;">Contact us at <a href="mailto:${config.supportEmail || config.senderEmail}" style="color: #0f172a;">${config.supportEmail || config.senderEmail}</a></p>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: `${config.senderName} <${config.senderEmail}>`,
      to: customerEmail,
      subject,
      html,
    });
    await logEmail(shop, bookingId, "overdue", customerEmail, subject, "sent");
  } catch {
    await logEmail(shop, bookingId, "overdue", customerEmail, subject, "failed");
  }
}
