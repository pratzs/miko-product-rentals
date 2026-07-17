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
 * domain: RESEND_API_KEY + MIKO_SENDER_EMAIL (e.g. "hello@miko.co.nz").
 * Without RESEND_API_KEY every send is a silent no-op, nothing breaks.
 */

const APP_NAME = "Miko Product Rentals";
const APP_HANDLE = "miko-product-rentals";
const REVIEW_URL = `https://apps.shopify.com/${APP_HANDLE}#modal-show=WriteReviewModal`;
const REINSTALL_URL = `https://apps.shopify.com/${APP_HANDLE}`;
const SUPPORT_EMAIL = "hello@tripsterdevelopers.com";

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

/** Shared minimal wrapper: readable plain-style HTML, no images, no tracking
 * pixels. The opt-out line keeps these compliant as relationship emails. */
function wrap(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a202c;max-width:560px;margin:0 auto;padding:8px 4px;">
${bodyHtml}
<p style="color:#718096;font-size:13px;margin-top:28px;border-top:1px solid #e2e8f0;padding-top:14px;">
You are receiving this because you installed ${APP_NAME} on your Shopify store.
This is a one-off note, not a mailing list. If you would rather not hear from
us at all, just reply and say so, we will make sure of it.</p>
</div>`;
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
<p>Hi ${name},</p>
<p>Thanks for installing ${APP_NAME}. I am Pratham, the founder, and I wanted
to say hello personally.</p>
<p>The fastest way to see it work: open the app, enable one product for rental, and add the calendar block to your product page from the theme editor. Bookings, deposits, and reminder emails run from there.</p>
<p>If anything is confusing, or you want a hand setting up, just reply to this
email. It comes straight to me and I usually answer the same day.</p>
<p>Pratham<br>Tripster Developers, Auckland NZ</p>`);

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
<p>Hi ${name},</p>
<p>I saw you uninstalled ${APP_NAME}, sorry to see you go.</p>
<p>If something did not work, was missing, or just was not what you expected,
I would genuinely like to know. Reply with one line and I will read it, that
kind of note is how the app gets better.</p>
<p>And if there is something we can fix or help set up, say the word. If you
ever want to give it another try, it is here:
<a href="${REINSTALL_URL}">${REINSTALL_URL}</a></p>
<p>Either way, thanks for trying it.</p>
<p>Pratham<br>Tripster Developers, Auckland NZ</p>`);

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
<p>Hi ${name},</p>
<p>You have had ${APP_NAME} for about a week now, so a quick question: how is
it going?</p>
<p>If it is saving you time, would you leave a short review on the App Store?
It takes about a minute and genuinely helps other merchants find the app:
<a href="${REVIEW_URL}">Leave a review</a></p>
<p>And if it is NOT going well, do not review it, reply to this email instead
and tell me what is wrong. I read every reply and I would rather fix your
problem than collect a star.</p>
<p>Pratham<br>Tripster Developers, Auckland NZ</p>`);

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

/** In-process daily scheduler for the review-request scan, same shape as the
 * bulk-job scheduler in cron.server.ts: singleton, non-overlapping, unref'd,
 * opt-out via DISABLE_IN_PROCESS_CRON. */
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
