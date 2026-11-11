import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { CrossSellSection } from "../components/CrossSellSection";
import { MikoMascot } from "../components/MikoMascot";
import { ReviewPrompt } from "../components/ReviewPrompt";
import { Banner, Grid, ProgressBar, badgeTone } from "../components/polaris";
import { MAIN_WITH_SIDEBAR, THREE_UP } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { dismissReviewPrompt, shouldShowReviewPrompt } from "../review-prompt.server";
import { format, isToday, isTomorrow } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { checkRentalLimit, getPlan } from "../utils/plans";
import { useT } from "../i18n/context";

/** Client-safe App Store write-a-review deep link for this app's listing. */
const APP_STORE_REVIEW_URL =
  "https://apps.shopify.com/miko-product-rentals#modal-show=WriteReviewModal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, totalProducts, liveProducts, totalBookingsCount, bookings] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalProduct.count({ where: { shop } }),
    // Active rentals always have pricing set (either a daily rate, or $0 with
    // a refundable deposit) — the activation guard enforces that — so this is
    // just the active count. Not filtering on pricePerDay alone, since a free
    // rental with a deposit is a valid active state.
    db.rentalProduct.count({ where: { shop, isActive: true } }),
    db.rentalBooking.count({ where: { shop } }),
    db.rentalBooking.findMany({
      where: { shop },
      include: { rentalProduct: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // ---- Onboarding: detect what the merchant has already done ----
  const steps = {
    productAdded: totalProducts > 0,
    pricingLive: liveProducts > 0,
    // The storefront block is "live" once it has called our API, or once any
    // real booking has come through (which proves the whole flow works).
    calendarLive: Boolean(config?.widgetSeenAt) || totalBookingsCount > 0,
    // The sitewide App Embed is "live" once it has pinged our embed-ping API
    // from a storefront page (which it does once per browser session).
    displayRulesLive: Boolean(config?.displayRulesSeenAt),
    emailReady: Boolean(config?.senderName && config.senderName.trim().length > 0),
  };
  const stepsDone = Object.values(steps).filter(Boolean).length;
  const totalSteps = Object.keys(steps).length;
  const allStepsDone = stepsDone === totalSteps;

  // Auto-complete onboarding once every step is detected, so the checklist
  // disappears on its own without the merchant clicking anything.
  if (config && allStepsDone && !config.onboardingCompleted) {
    await db.shopConfig
      .update({ where: { shop }, data: { onboardingCompleted: true } })
      .catch(() => {});
  }

  const now = new Date();
  // Auto-classify by date so counts are accurate even if the daily cron hasn't
  // run yet. Confirmed bookings whose start has arrived are "really" active.
  // Anything past its end date that hasn't been returned is "really" overdue.
  const activeBookings = bookings.filter(
    (b) =>
      (b.status === "active" || b.status === "confirmed") &&
      b.startDate <= now &&
      b.endDate >= now,
  );
  const overdueBookings = bookings.filter(
    (b) =>
      b.status !== "returned" &&
      b.status !== "cancelled" &&
      b.status !== "pending" &&
      b.status !== "needs_review" &&
      b.endDate < now,
  );
  const needsReviewBookings = bookings.filter((b) => b.status === "needs_review");
  const confirmedBookings = bookings.filter(
    (b) => b.status === "confirmed" && b.startDate > now,
  );
  const pendingPaymentBookings = bookings.filter((b) => b.status === "pending");
  const upcomingBookings = bookings
    .filter((b) => b.status === "confirmed" && b.startDate > now)
    .slice(0, 5);
  const returningTomorrow = bookings.filter(
    (b) =>
      (b.status === "active" || b.status === "overdue") &&
      isTomorrow(b.endDate),
  );
  const recentBookings = bookings.slice(0, 8);

  // Revenue counts only bookings tied to a captured payment - confirmed onwards.
  const earnedBookings = bookings.filter((b) =>
    ["confirmed", "active", "returned", "overdue"].includes(b.status),
  );
  const totalRevenue = earnedBookings.reduce((sum, b) => sum + b.rentalPrice, 0);
  const thisMonthRevenue = earnedBookings
    .filter((b) => {
      const d = new Date(b.createdAt);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((sum, b) => sum + b.rentalPrice, 0);

  // Deposit liability: money customers have paid that we still owe back to them.
  const depositsHeld = bookings
    .filter((b) => b.depositStatus === "held" && b.status !== "cancelled")
    .reduce((sum, b) => sum + b.depositAmount, 0);
  const depositsHeldCount = bookings.filter(
    (b) => b.depositStatus === "held" && b.status !== "cancelled",
  ).length;
  const pendingPaymentValue = pendingPaymentBookings.reduce(
    (sum, b) => sum + b.totalCharged,
    0,
  );

  const shopHandle = shop.replace(".myshopify.com", "");

  // Plan usage, so we can warn the merchant before bookings stop being created.
  const planName = config?.planName ?? "free";
  const limit = await checkRentalLimit(shop, planName, db);
  const planLabel = getPlan(planName).name;

  // Surface reinstall scenarios: merchant was previously on a paid plan that
  // got cancelled (either by uninstall or billing event) and they're now back
  // on free. Show a banner so they can reactivate.
  const reinstalledFromPaid =
    config?.subscriptionCancelledAt &&
    config?.planName === "free" &&
    config?.installedAt &&
    config.subscriptionCancelledAt > config.installedAt;

  const showReviewPrompt = await shouldShowReviewPrompt(shop);

  // Dry-run nudge: every real merchant who finished setup still had zero
  // bookings (measured 2026-09-02), so the step after "calendar live" is
  // proving the flow works by booking it yourself. Only fetch the storefront
  // URL in that narrow window — one Admin API call, and only until the first
  // booking arrives.
  let dryRun: { url: string; title: string } | null = null;
  if (steps.calendarLive && totalBookingsCount === 0 && liveProducts > 0) {
    try {
      const firstActive = await db.rentalProduct.findFirst({
        where: { shop, isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (firstActive) {
        const res = await admin.graphql(
          `#graphql
          query DryRunProductUrl($id: ID!) {
            product(id: $id) { title onlineStoreUrl onlineStorePreviewUrl }
          }`,
          { variables: { id: firstActive.shopifyProductId } },
        );
        const body = await res.json();
        const p = body?.data?.product;
        const url = p?.onlineStoreUrl || p?.onlineStorePreviewUrl;
        if (url) dryRun = { url, title: p.title || firstActive.shopifyProductTitle };
      }
    } catch {
      // The nudge is a nice-to-have; the dashboard must never fail over it.
    }
  }

  // The mirror image of the dry-run nudge, and the more damaging state: the
  // merchant has priced and activated rental products, but the booking calendar
  // has NEVER rendered on their storefront, so no shopper can book and nothing
  // tells them. Measured 2026-09-17: 4 of 11 external merchants sat in exactly
  // this state, one of them paying for the Pro plan. `widgetSeenAt` is set by
  // the storefront block's own ping, so "never" is a real signal, not an
  // inference.
  const calendarMissing =
    liveProducts > 0 && !config?.widgetSeenAt && totalBookingsCount === 0;

  return json({
    calendarMissing,
    dryRun,
    showReviewPrompt,
    shop,
    shopHandle,
    currency: config?.currency || "USD",
    onboardingCompleted: config?.onboardingCompleted || false,
    onboarding: { steps, stepsDone, totalSteps, allStepsDone },
    reinstalledFromPaid: Boolean(reinstalledFromPaid),
    usage: {
      planName,
      planLabel,
      current: limit.current,
      limit: limit.limit,
      atLimit: limit.current >= limit.limit,
      nearLimit: limit.current >= Math.floor(limit.limit * 0.8) && limit.current < limit.limit,
      isLifetime: planName === "free",
    },
    stats: {
      totalProducts,
      liveProducts,
      activeBookings: activeBookings.length,
      confirmedBookings: confirmedBookings.length,
      pendingPaymentBookings: pendingPaymentBookings.length,
      pendingPaymentValue,
      overdueBookings: overdueBookings.length,
      returningTomorrow: returningTomorrow.length,
      depositsHeld,
      depositsHeldCount,
      totalRevenue,
      thisMonthRevenue,
      totalBookings: bookings.length,
    },
    upcomingBookings: upcomingBookings.map((b) => ({
      id: b.id,
      customerName: b.customerName,
      productTitle: b.rentalProduct.shopifyProductTitle,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      orderName: b.shopifyOrderName,
    })),
    recentBookings: recentBookings.map((b) => ({
      id: b.id,
      customerName: b.customerName,
      productTitle: b.rentalProduct.shopifyProductTitle,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      status: b.status,
      totalCharged: b.totalCharged,
      orderName: b.shopifyOrderName,
    })),
    overdueCount: overdueBookings.length,
    needsReviewCount: needsReviewBookings.length,
  });
};

const STATUS_BADGE: Record<string, { tone: string; label: string }> = {
  pending:   { tone: "attention", label: "Pending payment" },
  confirmed: { tone: "info",      label: "Confirmed" },
  active:    { tone: "success",   label: "Out on rental" },
  returned:  { tone: "success",   label: "Returned" },
  overdue:   { tone: "critical",  label: "Overdue" },
  cancelled: { tone: "subdued",   label: "Canceled" },
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "review_prompt_dismiss") {
    await dismissReviewPrompt(session.shop);
  }
  return json({ ok: true });
};

export default function Dashboard() {
  const {
    stats,
    upcomingBookings,
    recentBookings,
    currency,
    onboardingCompleted,
    onboarding,
    usage,
    shopHandle,
    overdueCount,
    needsReviewCount,
    reinstalledFromPaid,
    showReviewPrompt,
    dryRun,
    calendarMissing,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const t = useT();

  // Deep-links to the product template with the "add block" prompt open for
  // the Miko Rental Calendar block (client ID + handle).
  const themeEditorUrl = `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?template=product&addAppBlockId=2306fcd511592e435b9b26ac07304811%2Fmiko-rental-calendar&target=newAppsSection`;

  // Deep-links to the theme's app embeds panel with the Miko Rental Display
  // Rules embed pre-selected and ready to activate.
  const displayRulesUrl = `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps&activateAppId=2306fcd511592e435b9b26ac07304811%2Frental-display-rules`;

  const setupSteps: {
    title: string;
    description: string;
    done: boolean;
    actionLabel: string;
    onAction: () => void;
  }[] = [
    {
      title: t("Add your first rental product"),
      description: t("Pick any product from your store and turn it into a rental. Its normal listing stays exactly the same."),
      done: onboarding.steps.productAdded,
      actionLabel: t("Add a product"),
      onAction: () => navigate("/app/products/new"),
    },
    {
      title: t("Set your pricing and switch it on"),
      description: t("Add a daily rate (weekly and monthly are optional), then activate the product so customers can book it."),
      done: onboarding.steps.pricingLive,
      actionLabel: t("Set pricing"),
      onAction: () => navigate("/app/products"),
    },
    {
      title: t("Show the booking calendar on your store"),
      description: t("Add the Miko Rental Calendar block to your product page in the theme editor. We tick this off automatically once it goes live."),
      done: onboarding.steps.calendarLive,
      actionLabel: t("Open theme editor"),
      onAction: () => window.open(themeEditorUrl, "_blank"),
    },
    {
      title: t("Turn on the storefront display rules"),
      description: t("Enable the Miko Rental Display Rules app embed. It hides the regular price and Add to cart button on rental products so customers only check out through the rental flow. Auto-detected once the embed loads on a storefront page."),
      done: onboarding.steps.displayRulesLive,
      actionLabel: t("Open app embeds"),
      onAction: () => window.open(displayRulesUrl, "_blank"),
    },
    {
      title: t("Set how your emails are signed"),
      description: t("Choose the sender name customers see on their booking confirmation and reminder emails."),
      done: onboarding.steps.emailReady,
      actionLabel: t("Set sender name"),
      onAction: () => navigate("/app/settings"),
    },
  ];

  const statCards = [
    {
      label: t("Out on rental now"),
      value: stats.activeBookings.toString(),
      sublabel:
        stats.confirmedBookings > 0
          ? t("{n} more confirmed, not yet started", { n: stats.confirmedBookings })
          : t("Items currently with customers"),
      tone: "subdued" as const,
      icon: "calendar" as const,
    },
    {
      label: t("Awaiting payment"),
      value: stats.pendingPaymentBookings.toString(),
      sublabel:
        stats.pendingPaymentBookings > 0
          ? t("{amount} unpaid. Mark orders paid in Shopify.", {
              amount: formatCurrency(stats.pendingPaymentValue, currency),
            })
          : t("All recent orders are paid"),
      tone: stats.pendingPaymentBookings > 0 ? ("caution" as const) : ("subdued" as const),
      icon: "credit-card" as const,
    },
    {
      label: t("Overdue returns"),
      value: stats.overdueBookings.toString(),
      sublabel: stats.overdueBookings > 0 ? t("Past the return date") : t("Everything on track"),
      tone: stats.overdueBookings > 0 ? ("critical" as const) : ("subdued" as const),
      icon: "clock" as const,
    },
    {
      label: t("Deposits held"),
      value: formatCurrency(stats.depositsHeld, currency),
      sublabel:
        stats.depositsHeldCount > 0
          ? stats.depositsHeldCount > 1
            ? t("Owed back across {n} bookings", { n: stats.depositsHeldCount })
            : t("Owed back across {n} booking", { n: stats.depositsHeldCount })
          : t("No deposits outstanding"),
      tone: "subdued" as const,
      icon: "cash-dollar" as const,
    },
    {
      label: t("Revenue this month"),
      value: formatCurrency(stats.thisMonthRevenue, currency),
      sublabel: t("{amount} all time (rental fees only)", {
        amount: formatCurrency(stats.totalRevenue, currency),
      }),
      tone: "subdued" as const,
      icon: "cash-dollar" as const,
    },
    {
      label: t("Rental products"),
      value: stats.totalProducts.toString(),
      sublabel: t("{n} total bookings", { n: stats.totalBookings }),
      tone: "subdued" as const,
      icon: "product" as const,
    },
  ];

  return (
    <s-page heading={t("Dashboard")} inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate(stats.totalProducts === 0 ? "/app/products" : "/app/bookings")}
      >
        {stats.totalProducts === 0 ? t("Enable your first rental") : t("View all bookings")}
      </s-button>
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Welcome to Miko Product Rentals")}</s-text>

        {/* Hero: the navy Miko brand block, kept as our own design. */}
        <div
          className="miko-gradient-bg"
          style={{ borderRadius: 12, padding: "28px 32px", display: "flex", alignItems: "center", gap: 32 }}
        >
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14, position: "relative" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="miko-status-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: "#3ecf8e", boxShadow: "0 0 8px #3ecf8e", flexShrink: 0 }} />
              <s-text>
                <span style={{ color: "rgba(255,255,255,0.8)" }}>
                  {stats.totalProducts > 0 ? t("Your rentals are live") : t("Let's set up your first rental")}
                </span>
              </s-text>
            </div>
            <s-heading>
              <span style={{ color: "white", fontSize: 24, lineHeight: 1.25 }}>{t("Rent out your products, effortlessly.")}</span>
            </s-heading>
            <s-paragraph>
              <span style={{ color: "rgba(255,255,255,0.9)" }}>
                {t("Let customers book by the day with live availability, flexible dates, and refundable deposits, all handled automatically at checkout.")}
              </span>
            </s-paragraph>
            <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <s-button variant="primary" onClick={() => navigate(stats.totalProducts === 0 ? "/app/products" : "/app/bookings")}>
                {stats.totalProducts === 0 ? t("Enable your first rental") : t("View bookings")}
              </s-button>
              <s-button variant="secondary" onClick={() => navigate("/app/help")}>
                {t("See how it works")}
              </s-button>
            </div>
          </div>
          <div className="miko-side-mascot" style={{ flexShrink: 0, position: "relative" }}>
            <MikoMascot size="lg" pose="present" />
          </div>
        </div>

        {showReviewPrompt && (
          <ReviewPrompt
            reviewUrl={APP_STORE_REVIEW_URL}
            title={t("Your first rental booking just came through")}
            message={t("If Miko Product Rentals is working well for you, a short review on the Shopify App Store helps other rental businesses find it, and means a lot to our small team in Auckland.")}
          />
        )}
        {!onboardingCompleted && (
          <s-section>
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-300">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small-200">
                  <s-heading>{t("Get your rentals up and running")}</s-heading>
                  <s-badge tone={onboarding.allStepsDone ? "success" : "caution"}>
                    {t("{done} of {total} done", {
                      done: onboarding.stepsDone,
                      total: onboarding.totalSteps,
                    })}
                  </s-badge>
                </s-stack>
                <s-paragraph color="subdued">
                  {t("Work through these steps and your first product will be ready to rent. Each one ticks itself off as soon as we detect it is done, so there is nothing to mark by hand.")}
                </s-paragraph>
              </s-stack>

              <ProgressBar
                progress={(onboarding.stepsDone / onboarding.totalSteps) * 100}
                tone="success"
                label={t("{done} of {total} done", { done: onboarding.stepsDone, total: onboarding.totalSteps })}
              />

              <s-stack direction="block" gap="none">
                {setupSteps.map((step, i) => (
                  <s-box key={step.title}>
                    {i > 0 && <s-divider />}
                    <s-box paddingBlock="small">
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-box minInlineSize="28px">
                          {step.done ? (
                            <s-icon type="check-circle" tone="success" />
                          ) : (
                            // s-box has no fully round radius, so the numbered
                            // step marker is a plain circle with a neutral ring.
                            <div style={{ width: 26, height: 26, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <s-text color="subdued" fontWeight="medium">{i + 1}</s-text>
                            </div>
                          )}
                        </s-box>
                        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                          <s-stack direction="block" gap="none">
                            <s-text fontWeight="medium" color={step.done ? "subdued" : undefined}>
                              {step.title}
                            </s-text>
                            <s-text color="subdued">{step.description}</s-text>
                          </s-stack>
                        </div>
                        <s-box>
                          {step.done ? (
                            <s-badge tone="success">{t("Done")}</s-badge>
                          ) : (
                            <s-button onClick={step.onAction}>{step.actionLabel}</s-button>
                          )}
                        </s-box>
                      </s-stack>
                    </s-box>
                  </s-box>
                ))}
              </s-stack>

              {onboarding.allStepsDone && (
                <Banner tone="success" title={t("You are all set. Your store is ready to take rental bookings.")}>
                  <s-paragraph>{t("This checklist will disappear on its own now that every step is complete.")}</s-paragraph>
                </Banner>
              )}

              <s-stack direction="inline">
                <s-button variant="tertiary" onClick={() => navigate("/app/help")}>
                  {t("Full setup guide and FAQ →")}
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        {calendarMissing && (
          <Banner
            tone="critical"
            title={t("No customer can book yet: the calendar is not on your product page")}
            action={{
              content: t("Add the booking calendar"),
              onAction: () => window.open(themeEditorUrl, "_top"),
            }}
          >
            <s-paragraph>
              {t("Your rental products are priced and switched on, but the Miko booking calendar has never appeared on your storefront, so there is no way for a shopper to pick dates or check out. It has to be added to your product template once. This takes about a minute and the banner clears itself the first time the calendar loads.")}
            </s-paragraph>
          </Banner>
        )}

        {dryRun && (
          <Banner
            tone="info"
            title={t("Setup is done: now book it yourself, once")}
            action={{
              content: t("Open {product} on your store", { product: dryRun.title }),
              onAction: () => window.open(dryRun.url, "_blank"),
            }}
          >
            <s-paragraph>
              {t("The fastest way to know everything works is a dry run: open your rental on the storefront, pick dates, and check out exactly like a customer would. You will see the booking land here within a minute, and you can cancel and refund it straight away. This banner disappears on its own after the first booking.")}
            </s-paragraph>
          </Banner>
        )}

        {usage.atLimit && (
          <Banner
            title={
              usage.isLifetime
                ? t("You have reached your {plan} plan limit of {limit} rentals", {
                    plan: usage.planLabel,
                    limit: usage.limit,
                  })
                : t("You have reached your {plan} plan limit of {limit} rentals this month", {
                    plan: usage.planLabel,
                    limit: usage.limit,
                  })
            }
            tone="warning"
            action={{ content: t("See plans"), onAction: () => navigate("/app/pricing") }}
          >
            <s-paragraph>
              {usage.isLifetime
                ? t("New online bookings are paused until you upgrade. Your existing bookings are safe. Upgrade any time to start taking rentals again right away.")
                : t("New online bookings are paused until you upgrade, or until your count resets next month. Your existing bookings are safe. Upgrade any time to start taking rentals again right away.")}
            </s-paragraph>
          </Banner>
        )}

        {usage.nearLimit && !usage.atLimit && (
          <Banner
            title={t("You have used {current} of your {limit} rentals on the {plan} plan", {
              current: usage.current,
              limit: usage.limit,
              plan: usage.planLabel,
            })}
            tone="info"
            action={{ content: t("See plans"), onAction: () => navigate("/app/pricing") }}
          >
            <s-paragraph>{t("You are getting close to your plan limit. Upgrading now keeps new bookings flowing without a gap.")}</s-paragraph>
          </Banner>
        )}

        {reinstalledFromPaid && (
          <Banner
            tone="warning"
            title={t("Welcome back. Your previous paid plan has ended.")}
            action={{ content: t("Reactivate plan"), onAction: () => navigate("/app/pricing") }}
          >
            <s-paragraph>
              {t("Your previous Miko subscription was canceled when you uninstalled the app. You're back on the Free plan. Reactivate any paid plan to lift the rental limits.")}
            </s-paragraph>
          </Banner>
        )}

        {needsReviewCount > 0 && (
          <Banner
            title={
              needsReviewCount > 1
                ? t("{n} bookings need review", { n: needsReviewCount })
                : t("{n} booking needs review", { n: needsReviewCount })
            }
            tone="warning"
            action={{ content: t("Review now"), onAction: () => navigate("/app/bookings?status=needs_review") }}
          >
            <s-paragraph>
              {t("Orders came in for dates that would exceed your available units. Reach out to those customers to adjust dates or refund, otherwise you may end up overbooked.")}
            </s-paragraph>
          </Banner>
        )}

        {overdueCount > 0 && (
          <Banner
            title={
              overdueCount > 1
                ? t("{n} rentals are overdue", { n: overdueCount })
                : t("{n} rental is overdue", { n: overdueCount })
            }
            tone="critical"
            action={{ content: t("Review overdue bookings"), onAction: () => navigate("/app/bookings?status=overdue") }}
          >
            <s-paragraph>{t("These items have not been returned past their due date. Contact the customers and apply late fees if needed.")}</s-paragraph>
          </Banner>
        )}

        {/* Stats row */}
        <Grid columns={THREE_UP} gap="base">
          {statCards.map((card) => (
            <s-section key={card.label}>
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-box background="subdued" borderRadius="base" padding="small-300">
                    <s-icon
                      type={card.icon}
                      tone={card.tone === "subdued" ? undefined : card.tone}
                      color={card.tone === "subdued" ? "subdued" : undefined}
                    />
                  </s-box>
                  <s-text color="subdued">{card.label}</s-text>
                </s-stack>
                <s-text fontSize="large-100" fontWeight="bold">{card.value}</s-text>
                <s-text color="subdued">{card.sublabel}</s-text>
              </s-stack>
            </s-section>
          ))}
        </Grid>

        <Grid columns={MAIN_WITH_SIDEBAR} gap="base">
          {/* Recent bookings table */}
          <s-section padding="none" accessibilityLabel={t("Recent bookings")}>
            <s-box padding="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-heading>{t("Recent bookings")}</s-heading>
                <s-button variant="tertiary" onClick={() => navigate("/app/bookings")}>
                  {t("View all")}
                </s-button>
              </s-stack>
            </s-box>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="kicker">{t("Order")}</s-table-header>
                <s-table-header listSlot="primary">{t("Customer")}</s-table-header>
                <s-table-header listSlot="secondary">{t("Product")}</s-table-header>
                <s-table-header>{t("Start date")}</s-table-header>
                <s-table-header>{t("Return by")}</s-table-header>
                <s-table-header format="currency">{t("Charged")}</s-table-header>
                <s-table-header listSlot="inline">{t("Status")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentBookings.map((b) => {
                  const badge = STATUS_BADGE[b.status];
                  return (
                    <s-table-row key={b.id}>
                      <s-table-cell>{b.orderName || "-"}</s-table-cell>
                      <s-table-cell>{b.customerName}</s-table-cell>
                      <s-table-cell>{b.productTitle}</s-table-cell>
                      <s-table-cell>{format(new Date(b.startDate), "d MMM yyyy")}</s-table-cell>
                      <s-table-cell>{format(new Date(b.endDate), "d MMM yyyy")}</s-table-cell>
                      <s-table-cell>{formatCurrency(b.totalCharged, currency)}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={badgeTone(badge?.tone)}>
                          {badge ? t(badge.label) : b.status}
                        </s-badge>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
                <s-empty-state heading={t("No bookings yet")}>
                  <s-text slot="subheading">{t("Once customers rent products, their bookings will appear here.")}</s-text>
                </s-empty-state>
              </s-table-body>
            </s-table>
          </s-section>

          {/* Upcoming starts */}
          <s-section>
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-300">
                <s-heading>{t("Upcoming rentals")}</s-heading>
                <s-text color="subdued">{t("Confirmed bookings starting soon")}</s-text>
              </s-stack>
              {upcomingBookings.length === 0 ? (
                <s-text color="subdued">{t("No upcoming rentals.")}</s-text>
              ) : (
                <s-stack direction="block" gap="small">
                  {upcomingBookings.map((b, i) => (
                    <s-box key={b.id}>
                      {i > 0 && <s-divider />}
                      <s-box paddingBlockStart={i > 0 ? "small" : "none"}>
                        <s-stack direction="block" gap="small-300">
                          <s-stack direction="inline" justifyContent="space-between" gap="small-200">
                            <s-text fontWeight="medium">{b.customerName}</s-text>
                            <s-badge tone={isToday(new Date(b.startDate)) ? "success" : isTomorrow(new Date(b.startDate)) ? "caution" : "info"}>
                              {isToday(new Date(b.startDate))
                                ? t("Starts today")
                                : isTomorrow(new Date(b.startDate))
                                ? t("Starts tomorrow")
                                : format(new Date(b.startDate), "d MMM")}
                            </s-badge>
                          </s-stack>
                          <s-text color="subdued">{b.productTitle}</s-text>
                          <s-text color="subdued">
                            {t("Returns {date}", { date: format(new Date(b.endDate), "d MMM yyyy") })}
                          </s-text>
                        </s-stack>
                      </s-box>
                    </s-box>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </s-section>
        </Grid>

        <CrossSellSection currentApp="rentals" />
      </s-stack>
    </s-page>
  );
}
