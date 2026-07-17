import { Resend } from "resend";
import { db as prisma } from "./db.server";

/**
 * Lifecycle emails: three one-off relationship emails per shop, never
 * campaigns and never repeated.
 *
 *  1. Welcome         - sent once from afterAuth on first install
 *  2. Day-7 review    - sent once by the daily in-process scan, 7+ days after
 *                       install, skipped if the merchant already interacted
 *                       with the in-app review prompt or uninstalled
 *  3. Uninstall       - sent once from the app/uninstalled webhook
 *
 * Every send is guarded by a sentAt timestamp on ShopConfig, so retries and
 * scheduler overlaps are idempotent. All sends are best-effort: a failure is
 * captured and never blocks auth, webhooks, or the scheduler.
 *
 * Sender identity comes from env so all Miko apps share one verified Resend
 * domain: RESEND_API_KEY + MIKO_SENDER_EMAIL (noreply@miko.co.nz). Without
 * RESEND_API_KEY every send is a silent no-op, nothing breaks.
 */

const APP_NAME = "Miko Product Rentals";
const APP_HANDLE = "miko-product-rentals";
const REVIEW_URL = `https://apps.shopify.com/${APP_HANDLE}#modal-show=WriteReviewModal`;
const REINSTALL_URL = `https://apps.shopify.com/${APP_HANDLE}`;
const SUPPORT_EMAIL = "hello@tripsterdevelopers.com";
const APP_ICON_URL = "https://miko.co.nz/assets/app-icons/rentals.png?v=5";
const LEARN_URL = "https://miko.co.nz/rentals-docs";

// Miko brand palette (matches miko.co.nz)
const NAVY = "#0D1527";
const MUTED = "#3D5280";
const GOLD = "#F5B731";
const BORDER = "#E6EAF4";
const PAGE_BG = "#F4F6FB";

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

function sender(): string {
  const email = process.env.MIKO_SENDER_EMAIL || "onboarding@resend.dev";
  const name = process.env.MIKO_SENDER_NAME || "Pratham from Miko";
  return `${name} <${email}>`;
}

function firstName(full: string | null | undefined): string {
  const name = (full || "").trim().split(/\s+/)[0];
  return name || "there";
}

/** Bulletproof CTA button (table-based so Outlook renders it too). */
function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px;">
  <tr><td align="center" bgcolor="${NAVY}" style="border-radius:8px;">
    <a href="${url}" target="_blank"
       style="display:inline-block;padding:13px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:8px;">
      ${label}</a>
  </td></tr></table>`;
}

/** Branded, email-client-safe wrapper: Miko icon header, white card, footer
 * with real links, and the opt-out line that keeps these compliant as
 * one-off relationship emails. No tracking pixels. */
function wrap(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en"><body style="margin:0;padding:0;background-color:${PAGE_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}">
<tr><td align="center" style="padding:32px 14px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

    <tr><td style="padding:0 6px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td><img src="${APP_ICON_URL}" width="42" height="42" alt="${APP_NAME}" style="display:block;border-radius:10px;"></td>
        <td style="padding-left:12px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;color:${NAVY};">${APP_NAME}</td>
      </tr></table>
    </td></tr>

    <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid ${BORDER};border-top:4px solid ${GOLD};border-radius:14px;padding:34px 34px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:${MUTED};">
${bodyHtml}
    </td></tr>

    <tr><td style="padding:22px 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.7;color:#8CA0C8;">
      <a href="https://miko.co.nz" style="color:${MUTED};text-decoration:underline;">miko.co.nz</a>
      &nbsp;&middot;&nbsp;
      <a href="https://tripsterdevelopers.com/apps/" style="color:${MUTED};text-decoration:underline;">All Miko apps</a>
      &nbsp;&middot;&nbsp;
      <a href="mailto:${SUPPORT_EMAIL}" style="color:${MUTED};text-decoration:underline;">Support</a>
      <br><br>
      You are receiving this one-off note because you installed ${APP_NAME} on
      your Shopify store. This is not a mailing list. If you would rather not
      hear from us at all, just reply and say so, we will make sure of it.
      <br><br>
      Tripster Developers &middot; Auckland, New Zealand
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}

async function send(to: string, subject: string, html: string): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;
  try {
    const { error } = await resend.emails.send({
      from: sender(),
      to,
      replyTo: SUPPORT_EMAIL,
      subject,
      html,
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error("[lifecycle-emails/send]", err);
    return false;
  }
}

/** Capture the store owner's email + name once at install. Best-effort. */
export async function captureMerchantContact(
  admin: { graphql: (q: string) => Promise<{ json: () => Promise<any> }> },
  shop: string,
): Promise<void> {
  try {
    const res = await admin.graphql(`#graphql
      query ShopContact { shop { email shopOwnerName } }`);
    const data = await res.json();
    const email = data.data?.shop?.email as string | undefined;
    const name = data.data?.shop?.shopOwnerName as string | undefined;
    if (email) {
      await prisma.shopConfig.upsert({
        where: { shop },
        create: { shop, merchantEmail: email, merchantName: name ?? null },
        update: { merchantEmail: email, merchantName: name ?? null, uninstalledAt: null },
      });
    }
  } catch (err) {
    console.error("[lifecycle-emails/captureMerchantContact]", err);
  }
}

/** Welcome email, once per shop, fired from afterAuth. */
export async function sendWelcomeEmail(shop: string): Promise<void> {
  const config = await prisma.shopConfig.findUnique({
    where: { shop },
    select: { merchantEmail: true, merchantName: true, welcomeEmailSentAt: true },
  });
  if (!config?.merchantEmail || config.welcomeEmailSentAt) return;

  const name = firstName(config.merchantName);
  const html = wrap(`
<p style="margin:0 0 16px;font-size:19px;font-weight:bold;color:${NAVY};">Welcome aboard, ${name}</p>
<p style="margin:0 0 16px;">Thanks for installing ${APP_NAME}. I am Pratham, the founder, and I wanted to say hello personally.</p>
<p style="margin:0 0 16px;">The fastest way to see it work: open the app, enable one product for rental, and add the calendar block to your product page from the theme editor. Bookings, deposits, and reminder emails run from there.</p>
${ctaButton("Read the setup guide", LEARN_URL)}
<p style="margin:18px 0 0;">If anything is confusing, or you want a hand setting up, just reply to this email. It comes straight to me and I usually answer the same day.</p>
<p style="margin:18px 0 0;color:${NAVY};">Pratham<br><span style="color:${MUTED};">Tripster Developers, Auckland NZ</span></p>`);

  const ok = await send(config.merchantEmail, `Welcome to ${APP_NAME}`, html);
  if (ok) {
    await prisma.shopConfig.update({
      where: { shop },
      data: { welcomeEmailSentAt: new Date() },
    });
  }
}

/** Uninstall winback, once per shop, fired from the app/uninstalled webhook.
 * Marks uninstalledAt regardless of whether the email could be sent. */
export async function sendUninstallEmail(shop: string): Promise<void> {
  const config = await prisma.shopConfig.findUnique({
    where: { shop },
    select: { merchantEmail: true, merchantName: true, uninstallEmailSentAt: true },
  });
  await prisma.shopConfig
    .update({ where: { shop }, data: { uninstalledAt: new Date() } })
    .catch(() => {});
  if (!config?.merchantEmail || config.uninstallEmailSentAt) return;

  const name = firstName(config.merchantName);
  const html = wrap(`
<p style="margin:0 0 16px;font-size:19px;font-weight:bold;color:${NAVY};">Sorry to see you go, ${name}</p>
<p style="margin:0 0 16px;">I saw you uninstalled ${APP_NAME}.</p>
<p style="margin:0 0 16px;">If something did not work, was missing, or just was not what you expected, I would genuinely like to know.
<a href="mailto:${SUPPORT_EMAIL}" style="color:${NAVY};font-weight:bold;text-decoration:underline;">Reply with one line</a>
and I will read it, that kind of note is how the app gets better. If there is something we can fix or help set up, say the word.</p>
${ctaButton("Give it another try", REINSTALL_URL)}
<p style="margin:18px 0 0;">Either way, thanks for trying it.</p>
<p style="margin:18px 0 0;color:${NAVY};">Pratham<br><span style="color:${MUTED};">Tripster Developers, Auckland NZ</span></p>`);

  const ok = await send(config.merchantEmail, "Sorry to see you go", html);
  if (ok) {
    await prisma.shopConfig.update({
      where: { shop },
      data: { uninstallEmailSentAt: new Date() },
    });
  }
}

/** Daily scan: shops installed 7+ days ago that still have the app, have not
 * received this email, and have not already interacted with the in-app review
 * prompt. One email each, permanently recorded. */
export async function sendDueReviewRequestEmails(): Promise<number> {
  if (!getResend()) return 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const due = await prisma.shopConfig.findMany({
    where: {
      installedAt: { lte: sevenDaysAgo },
      reviewEmailSentAt: null,
      uninstalledAt: null,
      merchantEmail: { not: null },
      // Merchants who already saw and acted on the in-app prompt are not
      // asked again by email.
      reviewPromptDismissedAt: null,
    },
    select: { shop: true, merchantEmail: true, merchantName: true },
    take: 25, // bounded per tick; the rest go out on later ticks
  });

  let sent = 0;
  for (const config of due) {
    const name = firstName(config.merchantName);
    const html = wrap(`
<p style="margin:0 0 16px;font-size:19px;font-weight:bold;color:${NAVY};">How is it going, ${name}?</p>
<p style="margin:0 0 16px;">You have had ${APP_NAME} for about a week now, so a quick question: how is it working for you?</p>
<p style="margin:0 0 16px;">If it is saving you time, would you leave a short review on the App Store? It takes about a minute and genuinely helps other merchants find the app.</p>
${ctaButton("Leave a review", REVIEW_URL)}
<p style="margin:18px 0 0;">And if it is <strong style="color:${NAVY};">not</strong> going well, do not review it,
<a href="mailto:${SUPPORT_EMAIL}" style="color:${NAVY};font-weight:bold;text-decoration:underline;">reply to this email instead</a>
and tell me what is wrong. I read every reply and I would rather fix your problem than collect a star.</p>
<p style="margin:18px 0 0;color:${NAVY};">Pratham<br><span style="color:${MUTED};">Tripster Developers, Auckland NZ</span></p>`);

    const ok = await send(config.merchantEmail as string, `How is ${APP_NAME} working for you?`, html);
    if (ok) {
      await prisma.shopConfig.update({
        where: { shop: config.shop },
        data: { reviewEmailSentAt: new Date() },
      });
      sent += 1;
    }
  }
  return sent;
}

/** In-process daily scheduler for the review-request scan: singleton,
 * non-overlapping, unref'd, opt-out via DISABLE_IN_PROCESS_CRON. */
const LIFECYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h; sends are idempotent

declare global {
  // eslint-disable-next-line no-var
  var __mikoLifecycleScheduler: { running: boolean } | undefined;
}

async function lifecycleTick() {
  const state = globalThis.__mikoLifecycleScheduler;
  if (!state || state.running) return;
  state.running = true;
  try {
    await sendDueReviewRequestEmails();
  } catch (err) {
    console.error("[lifecycle-emails/tick]", err);
  } finally {
    state.running = false;
  }
}

export function startLifecycleScheduler() {
  if (process.env.DISABLE_IN_PROCESS_CRON === "true") return;
  if (globalThis.__mikoLifecycleScheduler) return;
  const timer = setInterval(() => {
    void lifecycleTick();
  }, LIFECYCLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  globalThis.__mikoLifecycleScheduler = { running: false };
  void lifecycleTick();
}
