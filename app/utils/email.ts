// Email notifications sent via Resend.
import { Resend } from "resend";
import { db } from "~/db.server";
import { format } from "date-fns";
import {
  compileBlocksToHtml,
  substituteVariables,
  defaultConfirmationBlocks,
  defaultReturnReminderBlocks,
  defaultOverdueBlocks,
  getDefaultSubject,
  type EmailBlock,
  type BrandSettings,
} from "./email-templates";

export interface BookingEmailData {
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

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  return new Resend(key);
}

async function sendViaSMTP(
  config: NonNullable<Awaited<ReturnType<typeof db.shopConfig.findUnique>>>,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  const replyTo = config.replyToEmail || undefined;
  await transporter.sendMail({
    from: `${config.smtpFromName || config.senderName || "Miko Rentals"} <${config.smtpFromEmail}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

async function getTemplateAndBrand(shop: string, type: string) {
  const [template, config] = await Promise.all([
    db.emailTemplate.findFirst({
      where: { shop, type, isActive: true },
      orderBy: { updatedAt: "desc" },
    }),
    db.shopConfig.findUnique({ where: { shop } }),
  ]);
  const brand: BrandSettings = {
    logoUrl: config?.brandLogoUrl ?? undefined,
    primaryColor: config?.brandPrimaryColor ?? "#1a1a1a",
    name: config?.brandName ?? shop,
  };
  return { template, brand, config };
}

async function dispatch(
  shop: string,
  bookingId: string,
  type: string,
  to: string,
  subject: string,
  html: string,
) {
  const [config, session] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.session.findFirst({ where: { shop, email: { not: null } }, select: { email: true } }),
  ]);

  // BYO SMTP takes priority when fully configured (Starter+ plan)
  const useSmtp = config?.smtpHost && config?.smtpUser && config?.smtpFromEmail;

  let sendError: Error | undefined;
  if (useSmtp && config) {
    try {
      await sendViaSMTP(config, to, subject, html);
    } catch (e) {
      sendError = e as Error;
    }
  } else {
    // App-level Resend (noreply@miko.co.nz)
    const resend = getResend();
    const fromName =
      config?.senderName ||
      config?.brandName ||
      (process.env.MIKO_SENDER_NAME ?? "Miko Rentals");
    const fromEmail = process.env.MIKO_SENDER_EMAIL ?? "noreply@miko.co.nz";
    // Reply-to: merchant custom → Shopify account email → nothing
    const replyTo = config?.replyToEmail || session?.email || undefined;
    const { error } = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      replyTo,
      to,
      subject,
      html,
    });
    if (error) sendError = new Error(error.message);
  }

  await db.emailLog.create({
    data: {
      shop,
      bookingId,
      type,
      recipientEmail: to,
      subject,
      status: sendError ? "failed" : "sent",
    },
  });
  if (sendError) throw sendError;
}

export async function sendBookingConfirmation(data: BookingEmailData) {
  const { template, brand, config } = await getTemplateAndBrand(
    data.shop,
    "confirmation",
  );
  const vars: Record<string, string> = {
    customer_name: data.customerName,
    customer_email: data.customerEmail,
    product_title: data.productTitle,
    order_name: data.orderName,
    start_date: format(data.startDate, "PPP"),
    end_date: format(data.endDate, "PPP"),
    rental_days: String(data.rentalDays),
    rental_price: formatMoney(data.rentalPrice, data.currency),
    deposit_amount: formatMoney(data.depositAmount, data.currency),
    shop_name: config?.brandName ?? data.shop,
    days_overdue: "0",
    late_fee_per_day: "0",
  };
  const blocks: EmailBlock[] = template
    ? (template.blocks as unknown as EmailBlock[])
    : defaultConfirmationBlocks();
  const subject = substituteVariables(
    template?.subject || getDefaultSubject("confirmation"),
    vars,
  );
  const html = substituteVariables(
    compileBlocksToHtml(blocks, brand, subject),
    vars,
  );
  await dispatch(
    data.shop,
    data.bookingId,
    "confirmation",
    data.customerEmail,
    subject,
    html,
  );
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
  const { template, brand, config } = await getTemplateAndBrand(
    shop,
    "return_reminder",
  );
  const vars: Record<string, string> = {
    customer_name: customerName,
    customer_email: customerEmail,
    product_title: productTitle,
    order_name: "",
    start_date: "",
    end_date: format(endDate, "PPP"),
    rental_days: "",
    rental_price: "",
    deposit_amount: "",
    shop_name: config?.brandName ?? shop,
    days_overdue: "0",
    late_fee_per_day: "0",
  };
  const blocks: EmailBlock[] = template
    ? (template.blocks as unknown as EmailBlock[])
    : defaultReturnReminderBlocks();
  const subject = substituteVariables(
    template?.subject || getDefaultSubject("return_reminder"),
    vars,
  );
  const html = substituteVariables(
    compileBlocksToHtml(blocks, brand, subject),
    vars,
  );
  await dispatch(shop, bookingId, "return_reminder", customerEmail, subject, html);
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
  const { template, brand, config } = await getTemplateAndBrand(
    shop,
    "overdue",
  );
  const now = new Date();
  const daysOverdue = Math.floor(
    (now.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  const vars: Record<string, string> = {
    customer_name: customerName,
    customer_email: customerEmail,
    product_title: productTitle,
    order_name: "",
    start_date: "",
    end_date: format(endDate, "PPP"),
    rental_days: "",
    rental_price: "",
    deposit_amount: "",
    shop_name: config?.brandName ?? shop,
    days_overdue: String(daysOverdue),
    late_fee_per_day: formatMoney(lateFeePerDay, currency),
  };
  const blocks: EmailBlock[] = template
    ? (template.blocks as unknown as EmailBlock[])
    : defaultOverdueBlocks();
  const subject = substituteVariables(
    template?.subject || getDefaultSubject("overdue"),
    vars,
  );
  const html = substituteVariables(
    compileBlocksToHtml(blocks, brand, subject),
    vars,
  );
  await dispatch(shop, bookingId, "overdue", customerEmail, subject, html);
}
