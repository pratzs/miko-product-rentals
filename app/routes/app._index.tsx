import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { CrossSellSection } from "../components/CrossSellSection";
import { MikoMascot } from "../components/MikoMascot";
import { ReviewPrompt } from "../components/ReviewPrompt";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  Badge,
  DataTable,
  EmptyState,
  Banner,
  Box,
  Divider,
  Icon,
  ProgressBar,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  CalendarIcon,
  CashDollarIcon,
  ClockIcon,
  AlertCircleIcon,
  ProductIcon,
  CreditCardIcon,
} from "@shopify/polaris-icons";
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

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
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
      accent: "#10b981",
      accentBg: "#ecfdf5",
      icon: CalendarIcon,
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
      accent: stats.pendingPaymentBookings > 0 ? "#f59e0b" : "#9ca3af",
      accentBg: stats.pendingPaymentBookings > 0 ? "#fffbeb" : "#f3f4f6",
      icon: CreditCardIcon,
    },
    {
      label: t("Overdue returns"),
      value: stats.overdueBookings.toString(),
      sublabel: stats.overdueBookings > 0 ? t("Past the return date") : t("Everything on track"),
      accent: stats.overdueBookings > 0 ? "#ef4444" : "#9ca3af",
      accentBg: stats.overdueBookings > 0 ? "#fef2f2" : "#f3f4f6",
      icon: ClockIcon,
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
      accent: "#6366f1",
      accentBg: "#eef2ff",
      icon: CashDollarIcon,
    },
    {
      label: t("Revenue this month"),
      value: formatCurrency(stats.thisMonthRevenue, currency),
      sublabel: t("{amount} all time (rental fees only)", {
        amount: formatCurrency(stats.totalRevenue, currency),
      }),
      accent: "#0ea5e9",
      accentBg: "#f0f9ff",
      icon: CashDollarIcon,
    },
    {
      label: t("Rental products"),
      value: stats.totalProducts.toString(),
      sublabel: t("{n} total bookings", { n: stats.totalBookings }),
      accent: "#8b5cf6",
      accentBg: "#f5f3ff",
      icon: ProductIcon,
    },
  ];

  const tableRows = recentBookings.map((b) => {
    const badge = STATUS_BADGE[b.status];
    return [
      b.orderName || "-",
      b.customerName,
      b.productTitle,
      format(new Date(b.startDate), "d MMM yyyy"),
      format(new Date(b.endDate), "d MMM yyyy"),
      formatCurrency(b.totalCharged, currency),
      <Badge tone={badge?.tone || "subdued"}>
        {badge ? t(badge.label) : b.status}
      </Badge>,
    ];
  });

  return (
    <Page
      title={t("Dashboard")}
      subtitle={t("Welcome to Miko Product Rentals")}
      primaryAction={
        stats.totalProducts === 0
          ? { content: t("Enable your first rental"), onAction: () => navigate("/app/products") }
          : { content: t("View all bookings"), onAction: () => navigate("/app/bookings") }
      }
    >
      <BlockStack gap="600">
        {/* Hero */}
        <div
          className="miko-gradient-bg"
          style={{ borderRadius: 16, padding: "28px 32px", display: "flex", alignItems: "center", gap: 32 }}
        >
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="miko-status-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: "#3ecf8e", boxShadow: "0 0 8px #3ecf8e", flexShrink: 0 }} />
              <Text as="span" variant="bodySm">
                <span style={{ color: "rgba(255,255,255,0.8)" }}>
                  {stats.totalProducts > 0 ? t("Your rentals are live") : t("Let's set up your first rental")}
                </span>
              </Text>
            </div>
            <Text as="h2" variant="headingXl" fontWeight="bold">
              <span style={{ color: "white" }}>{t("Rent out your products, effortlessly.")}</span>
            </Text>
            <Text as="p" variant="bodyLg">
              <span style={{ color: "rgba(255,255,255,0.9)" }}>
                {t("Let customers book by the day with live availability, flexible dates, and refundable deposits, all handled automatically at checkout.")}
              </span>
            </Text>
            <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <Button variant="primary" tone="success" size="large" onClick={() => navigate(stats.totalProducts === 0 ? "/app/products" : "/app/bookings")}>
                {stats.totalProducts === 0 ? t("Enable your first rental") : t("View bookings")}
              </Button>
              <Button variant="secondary" size="large" onClick={() => navigate("/app/help")}>
                {t("See how it works")}
              </Button>
            </div>
          </div>
          <div className="miko-side-mascot" style={{ flexShrink: 0 }}>
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
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">{t("Get your rentals up and running")}</Text>
                  <Badge tone={onboarding.allStepsDone ? "success" : "attention"}>
                    {t("{done} of {total} done", {
                      done: onboarding.stepsDone,
                      total: onboarding.totalSteps,
                    })}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {t("Work through these steps and your first product will be ready to rent. Each one ticks itself off as soon as we detect it is done, so there is nothing to mark by hand.")}
                </Text>
              </BlockStack>

              <ProgressBar progress={(onboarding.stepsDone / onboarding.totalSteps) * 100} tone="success" size="small" />

              <BlockStack gap="0">
                {setupSteps.map((step, i) => (
                  <Box key={step.title}>
                    {i > 0 && <Divider />}
                    <Box paddingBlock="300">
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <Box minWidth="28px">
                          {step.done ? (
                            <Icon source={CheckCircleIcon} tone="success" />
                          ) : (
                            <Box
                              background="bg-surface-secondary"
                              borderColor="border"
                              borderWidth="025"
                              borderRadius="full"
                              minWidth="28px"
                              minHeight="28px"
                            >
                              <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">{i + 1}</Text>
                              </div>
                            </Box>
                          )}
                        </Box>
                        <Box width="100%">
                          <BlockStack gap="050">
                            <Text as="p" variant="bodyMd" fontWeight="medium" tone={step.done ? "subdued" : undefined}>
                              {step.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">{step.description}</Text>
                          </BlockStack>
                        </Box>
                        <Box minWidth="fit-content">
                          {step.done ? (
                            <Badge tone="success">{t("Done")}</Badge>
                          ) : (
                            <Button onClick={step.onAction}>{step.actionLabel}</Button>
                          )}
                        </Box>
                      </InlineStack>
                    </Box>
                  </Box>
                ))}
              </BlockStack>

              {onboarding.allStepsDone && (
                <Banner tone="success" title={t("You are all set. Your store is ready to take rental bookings.")}>
                  <p>{t("This checklist will disappear on its own now that every step is complete.")}</p>
                </Banner>
              )}

              <InlineStack>
                <Button variant="plain" onClick={() => navigate("/app/help")}>
                  {t("Full setup guide and FAQ →")}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
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
            <p>
              {t("Your rental products are priced and switched on, but the Miko booking calendar has never appeared on your storefront, so there is no way for a shopper to pick dates or check out. It has to be added to your product template once. This takes about a minute and the banner clears itself the first time the calendar loads.")}
            </p>
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
            <p>
              {t("The fastest way to know everything works is a dry run: open your rental on the storefront, pick dates, and check out exactly like a customer would. You will see the booking land here within a minute, and you can cancel and refund it straight away. This banner disappears on its own after the first booking.")}
            </p>
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
            <p>
              {usage.isLifetime
                ? t("New online bookings are paused until you upgrade. Your existing bookings are safe. Upgrade any time to start taking rentals again right away.")
                : t("New online bookings are paused until you upgrade, or until your count resets next month. Your existing bookings are safe. Upgrade any time to start taking rentals again right away.")}
            </p>
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
            <p>{t("You are getting close to your plan limit. Upgrading now keeps new bookings flowing without a gap.")}</p>
          </Banner>
        )}

        {reinstalledFromPaid && (
          <Banner
            tone="warning"
            title={t("Welcome back. Your previous paid plan has ended.")}
            action={{ content: t("Reactivate plan"), onAction: () => navigate("/app/pricing") }}
          >
            <p>
              {t("Your previous Miko subscription was canceled when you uninstalled the app. You're back on the Free plan. Reactivate any paid plan to lift the rental limits.")}
            </p>
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
            <p>
              {t("Orders came in for dates that would exceed your available units. Reach out to those customers to adjust dates or refund, otherwise you may end up overbooked.")}
            </p>
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
            <p>{t("These items have not been returned past their due date. Contact the customers and apply late fees if needed.")}</p>
          </Banner>
        )}

        {/* Stats row */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
          {statCards.map((card) => (
            <Card key={card.label}>
              <BlockStack gap="300">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <Text as="p" variant="bodyMd" tone="subdued">{card.label}</Text>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: card.accentBg,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: card.accent,
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon source={card.icon} />
                    </div>
                  </div>
                </div>
                <Text as="p" variant="headingXl" fontWeight="bold">{card.value}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{card.sublabel}</Text>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>

        <Layout>
          {/* Recent bookings table */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">{t("Recent bookings")}</Text>
                  <Button variant="plain" onClick={() => navigate("/app/bookings")}>
                    {t("View all")}
                  </Button>
                </InlineStack>
                {recentBookings.length === 0 ? (
                  <EmptyState
                    heading={t("No bookings yet")}
                    image=""
                  >
                    <p>{t("Once customers rent products, their bookings will appear here.")}</p>
                  </EmptyState>
                ) : (
                  <DataTable
                    columnContentTypes={["text","text","text","text","text","numeric","text"]}
                    headings={[t("Order"),t("Customer"),t("Product"),t("Start date"),t("Return by"),t("Charged"),t("Status")]}
                    rows={tableRows}
                    hoverable
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Upcoming starts */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{t("Upcoming rentals")}</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {t("Confirmed bookings starting soon")}
                </Text>
                {upcomingBookings.length === 0 ? (
                  <Text as="p" tone="subdued">{t("No upcoming rentals.")}</Text>
                ) : (
                  <BlockStack gap="300">
                    {upcomingBookings.map((b, i) => (
                      <Box key={b.id}>
                        {i > 0 && <Divider />}
                        <Box paddingBlockStart={i > 0 ? "300" : "0"}>
                          <BlockStack gap="100">
                            <InlineStack align="space-between">
                              <Text as="p" variant="bodyMd" fontWeight="medium">{b.customerName}</Text>
                              <Badge tone={isToday(new Date(b.startDate)) ? "success" : isTomorrow(new Date(b.startDate)) ? "attention" : "info"}>
                                {isToday(new Date(b.startDate))
                                  ? t("Starts today")
                                  : isTomorrow(new Date(b.startDate))
                                  ? t("Starts tomorrow")
                                  : format(new Date(b.startDate), "d MMM")}
                              </Badge>
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">{b.productTitle}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t("Returns {date}", { date: format(new Date(b.endDate), "d MMM yyyy") })}
                            </Text>
                          </BlockStack>
                        </Box>
                      </Box>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <CrossSellSection currentApp="rentals" />
      </BlockStack>
    </Page>
  );
}
