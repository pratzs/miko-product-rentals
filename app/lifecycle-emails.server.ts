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
 * scheduler overlaps are idempotent. All sends are best-effort and never
 * block auth, webhooks, or the scheduler. Without RESEND_API_KEY every send
 * is a silent no-op.
 *
 * Design: Miko brand (navy/gold, 3D robot hero) + Tripster Developers
 * sign-off, table-based markup so it renders in Outlook too. No tracking
 * pixels; the only images are the hosted app icon and mascot.
 */

const APP_NAME = "Miko Product Rentals";
const APP_HANDLE = "miko-product-rentals";
const REVIEW_URL = `https://apps.shopify.com/${APP_HANDLE}#modal-show=WriteReviewModal`;
const REINSTALL_URL = `https://apps.shopify.com/${APP_HANDLE}`;
const SUPPORT_EMAIL = "hello@tripsterdevelopers.com";
const APP_ICON_URL = "https://miko.co.nz/assets/app-icons/rentals.png?v=5";
const LEARN_URL = "https://miko.co.nz/rentals-docs";
const ROBOT_URL = "https://miko.co.nz/assets/miko-robot/miko-robot.png?v=2";

// Brand palette: Miko navy/gold (miko.co.nz) + Tripster red for the studio credit
const NAVY = "#0D1527";
const NAVY2 = "#243358";
const MUTED = "#3D5280";
const GOLD = "#F5B731";
const BORDER = "#E6EAF4";
const PAGE_BG = "#F4F6FB";
const TD_RED = "#E52D2D";
const FONT = "'Outfit','Segoe UI',Arial,Helvetica,sans-serif";

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

function para(text: string): string {
  return `<p style="margin:0 0 16px;">${text}</p>`;
}

/** Gold CTA button, table-based so Outlook renders it too. */
function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 6px;"><tr>
<td align="center" bgcolor="${GOLD}" style="border-radius:10px;">
<a href="${url}" target="_blank" style="display:inline-block;padding:15px 34px;font-family:${FONT};font-size:15px;font-weight:bold;color:${NAVY};text-decoration:none;border-radius:10px;letter-spacing:0.01em;">${label}</a>
</td></tr></table>`;
}

/** Branded wrapper: app-icon header, navy gradient hero with the 3D Miko
 * robot, gold accent rule, white body card, Tripster sign-off, linked footer,
 * and the opt-out line that keeps these compliant as one-off relationship
 * emails. */
function wrap(eyebrow: string, headline: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:0;background-color:${PAGE_BG};">
<div style="display:none;max-height:0;overflow:hidden;">${headline}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}"><tr><td align="center" style="padding:36px 14px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

<tr><td style="padding:0 8px 20px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="40"><img src="${APP_ICON_URL}" width="40" height="40" alt="" style="display:block;border-radius:10px;"></td>
    <td style="padding-left:12px;font-family:${FONT};font-size:16px;font-weight:bold;color:${NAVY};">${APP_NAME}</td>
    <td align="right" style="font-family:${FONT};font-size:11px;font-weight:bold;letter-spacing:0.14em;color:#8CA0C8;">MIKO&nbsp;APPS</td>
  </tr></table>
</td></tr>

<tr><td bgcolor="${NAVY}" style="background-color:${NAVY};background:linear-gradient(135deg,${NAVY} 0%,${NAVY2} 100%);border-radius:18px 18px 0 0;padding:34px 38px 26px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle;">
      <p style="margin:0 0 10px;font-family:${FONT};font-size:11px;font-weight:bold;letter-spacing:0.18em;color:${GOLD};">${eyebrow}</p>
      <p style="margin:0;font-family:${FONT};font-size:26px;line-height:1.25;font-weight:bold;color:#FFFFFF;">${headline}</p>
    </td>
    <td width="104" align="right" style="vertical-align:bottom;"><img src="${ROBOT_URL}" width="88" alt="Miko robot" style="display:block;"></td>
  </tr></table>
</td></tr>

<tr><td height="4" bgcolor="${GOLD}" style="font-size:0;line-height:0;">&nbsp;</td></tr>

<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid ${BORDER};border-top:none;border-radius:0 0 18px 18px;padding:36px 38px 30px;font-family:${FONT};font-size:15px;line-height:1.75;color:${MUTED};">
${bodyHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:30px;"><tr>
  <td style="border-top:1px solid ${BORDER};padding-top:20px;font-family:${FONT};font-size:14px;line-height:1.6;">
    <span style="color:${NAVY};font-weight:bold;">Pratham</span><br>
    <span style="color:${MUTED};">Founder, <a href="https://tripsterdevelopers.com" style="color:${TD_RED};font-weight:bold;text-decoration:none;">Tripster Developers</a> &middot; Auckland, NZ</span>
  </td>
</tr></table>
</td></tr>

<tr><td style="padding:24px 8px 0;font-family:${FONT};font-size:12.5px;line-height:1.8;color:#8CA0C8;">
  <a href="https://miko.co.nz" style="color:${MUTED};text-decoration:underline;">miko.co.nz</a>
  &nbsp;&middot;&nbsp;<a href="https://tripsterdevelopers.com/apps/" style="color:${MUTED};text-decoration:underline;">All Miko apps</a>
  &nbsp;&middot;&nbsp;<a href="mailto:${SUPPORT_EMAIL}" style="color:${MUTED};text-decoration:underline;">Support</a>
  <br><br>
  You are receiving this one-off note because you installed ${APP_NAME} on your Shopify store.
  This is not a mailing list. If you would rather not hear from us at all, just reply and say so, we will make sure of it.
  <br><br>
  Miko Apps &middot; built by <a href="https://tripsterdevelopers.com" style="color:${MUTED};text-decoration:underline;">Tripster Developers</a> &middot; Auckland, New Zealand
</td></tr>

</table></td></tr></table></body></html>`;
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
  const html = wrap(
    "WELCOME TO THE MIKO FAMILY",
    "Let us take your first booking.",
    para(`Hi ${name},`) +
      para(`Thanks for installing ${APP_NAME}. I am Pratham, the founder, and I wanted to say hello personally.`) +
      para("The fastest way to see it work: open the app, enable one product for rental, and add the calendar block to your product page from the theme editor. Bookings, deposits, and reminder emails run from there.") +
      ctaButton("Read the setup guide", LEARN_URL) +
      `<p style="margin:20px 0 0;">If anything is confusing, or you want a hand setting up, just reply to this email. It comes straight to me and I usually answer the same day.</p>`,
  );

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
  const html = wrap(
    "SORRY TO SEE YOU GO",
    "We would love another chance.",
    para(`Hi ${name},`) +
      para(`I saw you uninstalled ${APP_NAME}, sorry to see you go.`) +
      para(`If something did not work, was missing, or just was not what you expected, I would genuinely like to know. <a href="mailto:${SUPPORT_EMAIL}" style="color:${NAVY};font-weight:bold;">Reply with one line</a> and I will read it, that kind of note is how the app gets better.`) +
      ctaButton("Give it another try", REINSTALL_URL) +
      `<p style="margin:20px 0 0;">Either way, thanks for trying it.</p>`,
  );

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
    const html = wrap(
      "ONE WEEK IN",
      "How is it going so far?",
      para(`Hi ${name},`) +
        para(`You have had ${APP_NAME} for about a week now, so a quick question: how is it working for you?`) +
        para("If it is saving you time, would you leave a short review on the App Store? It takes about a minute and genuinely helps other merchants find the app.") +
        ctaButton("Leave a review", REVIEW_URL) +
        `<p style="margin:20px 0 0;">And if it is <strong style="color:${NAVY};">not</strong> going well, do not review it, <a href="mailto:${SUPPORT_EMAIL}" style="color:${NAVY};font-weight:bold;">reply to this email instead</a> and tell me what is wrong. I read every reply and I would rather fix your problem than collect a star.</p>`,
    );

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
