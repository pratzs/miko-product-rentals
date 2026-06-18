import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
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
import { format, isToday, isTomorrow } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { checkRentalLimit, getPlan } from "../utils/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, totalProducts, liveProducts, totalBookingsCount, bookings] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalProduct.count({ where: { shop } }),
    db.rentalProduct.count({ where: { shop, isActive: true, pricePerDay: { gt: 0 } } }),
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

  return json({
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
  cancelled: { tone: "subdued",   label: "Cancelled" },
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
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

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
      title: "Add your first rental product",
      description: "Pick any product from your store and turn it into a rental. Its normal listing stays exactly the same.",
      done: onboarding.steps.productAdded,
      actionLabel: "Add a product",
      onAction: () => navigate("/app/products/new"),
    },
    {
      title: "Set your pricing and switch it on",
      description: "Add a daily rate (weekly and monthly are optional), then activate the product so customers can book it.",
      done: onboarding.steps.pricingLive,
      actionLabel: "Set pricing",
      onAction: () => navigate("/app/products"),
    },
    {
      title: "Show the booking calendar on your store",
      description: "Add the Miko Rental Calendar block to your product page in the theme editor. We tick this off automatically once it goes live.",
      done: onboarding.steps.calendarLive,
      actionLabel: "Open theme editor",
      onAction: () => window.open(themeEditorUrl, "_blank"),
    },
    {
      title: "Turn on the storefront display rules",
      description: "Enable the Miko Rental Display Rules app embed. It hides the regular price and Add to cart button on rental products so customers only check out through the rental flow. Auto-detected once the embed loads on a storefront page.",
      done: onboarding.steps.displayRulesLive,
      actionLabel: "Open app embeds",
      onAction: () => window.open(displayRulesUrl, "_blank"),
    },
    {
      title: "Set how your emails are signed",
      description: "Choose the sender name customers see on their booking confirmation and reminder emails.",
      done: onboarding.steps.emailReady,
      actionLabel: "Set sender name",
      onAction: () => navigate("/app/settings"),
    },
  ];

  const statCards = [
    {
      label: "Out on rental now",
      value: stats.activeBookings.toString(),
      sublabel:
        stats.confirmedBookings > 0
          ? `${stats.confirmedBookings} more confirmed, not yet started`
          : "Items currently with customers",
      accent: "#10b981",
      accentBg: "#ecfdf5",
      icon: CalendarIcon,
    },
    {
      label: "Awaiting payment",
      value: stats.pendingPaymentBookings.toString(),
      sublabel:
        stats.pendingPaymentBookings > 0
          ? `${formatCurrency(stats.pendingPaymentValue, currency)} unpaid. Mark orders paid in Shopify.`
          : "All recent orders are paid",
      accent: stats.pendingPaymentBookings > 0 ? "#f59e0b" : "#9ca3af",
      accentBg: stats.pendingPaymentBookings > 0 ? "#fffbeb" : "#f3f4f6",
      icon: CreditCardIcon,
    },
    {
      label: "Overdue returns",
      value: stats.overdueBookings.toString(),
      sublabel: stats.overdueBookings > 0 ? "Past the return date" : "Everything on track",
      accent: stats.overdueBookings > 0 ? "#ef4444" : "#9ca3af",
      accentBg: stats.overdueBookings > 0 ? "#fef2f2" : "#f3f4f6",
      icon: ClockIcon,
    },
    {
      label: "Deposits held",
      value: formatCurrency(stats.depositsHeld, currency),
      sublabel:
        stats.depositsHeldCount > 0
          ? `Owed back across ${stats.depositsHeldCount} booking${stats.depositsHeldCount > 1 ? "s" : ""}`
          : "No deposits outstanding",
      accent: "#6366f1",
      accentBg: "#eef2ff",
      icon: CashDollarIcon,
    },
    {
      label: "Revenue this month",
      value: formatCurrency(stats.thisMonthRevenue, currency),
      sublabel: `${formatCurrency(stats.totalRevenue, currency)} all time (rental fees only)`,
      accent: "#0ea5e9",
      accentBg: "#f0f9ff",
      icon: CashDollarIcon,
    },
    {
      label: "Rental products",
      value: stats.totalProducts.toString(),
      sublabel: `${stats.totalBookings} total bookings`,
      accent: "#8b5cf6",
      accentBg: "#f5f3ff",
      icon: ProductIcon,
    },
  ];

  const tableRows = recentBookings.map((b) => [
    b.orderName || "-",
    b.customerName,
    b.productTitle,
    format(new Date(b.startDate), "d MMM yyyy"),
    format(new Date(b.endDate), "d MMM yyyy"),
    formatCurrency(b.totalCharged, currency),
    <Badge tone={STATUS_BADGE[b.status]?.tone || "subdued"}>
      {STATUS_BADGE[b.status]?.label || b.status}
    </Badge>,
  ]);

  return (
    <Page
      title="Dashboard"
      subtitle="Welcome to Miko Product Rentals"
      primaryAction={
        stats.totalProducts === 0
          ? { content: "Enable your first rental", onAction: () => navigate("/app/products") }
          : { content: "View all bookings", onAction: () => navigate("/app/bookings") }
      }
    >
      <BlockStack gap="600">
        {!onboardingCompleted && (
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Get your rentals up and running</Text>
                  <Badge tone={onboarding.allStepsDone ? "success" : "attention"}>
                    {`${onboarding.stepsDone} of ${onboarding.totalSteps} done`}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Work through these steps and your first product will be ready to rent. Each one ticks itself off as soon as we detect it is done, so there is nothing to mark by hand.
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
                            <Badge tone="success">Done</Badge>
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
                <Banner tone="success" title="You are all set. Your store is ready to take rental bookings.">
                  <p>This checklist will disappear on its own now that every step is complete.</p>
                </Banner>
              )}

              <InlineStack>
                <Button variant="plain" onClick={() => navigate("/app/help")}>
                  Full setup guide and FAQ →
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {usage.atLimit && (
          <Banner
            title={`You have reached your ${usage.planLabel} plan limit of ${usage.limit} rentals${usage.isLifetime ? "" : " this month"}`}
            tone="warning"
            action={{ content: "See plans", onAction: () => navigate("/app/pricing") }}
          >
            <p>
              New online bookings are paused until you upgrade
              {usage.isLifetime ? "" : ", or until your count resets next month"}. Your existing bookings are safe. Upgrade any time to start taking rentals again right away.
            </p>
          </Banner>
        )}

        {usage.nearLimit && !usage.atLimit && (
          <Banner
            title={`You have used ${usage.current} of your ${usage.limit} rentals on the ${usage.planLabel} plan`}
            tone="info"
            action={{ content: "See plans", onAction: () => navigate("/app/pricing") }}
          >
            <p>You are getting close to your plan limit. Upgrading now keeps new bookings flowing without a gap.</p>
          </Banner>
        )}

        {reinstalledFromPaid && (
          <Banner
            tone="warning"
            title="Welcome back. Your previous paid plan has ended."
            action={{ content: "Reactivate plan", onAction: () => navigate("/app/pricing") }}
          >
            <p>
              Your previous Miko subscription was cancelled when you uninstalled the app. You're back on the Free plan. Reactivate any paid plan to lift the rental limits.
            </p>
          </Banner>
        )}

        {needsReviewCount > 0 && (
          <Banner
            title={`${needsReviewCount} booking${needsReviewCount > 1 ? "s need" : " needs"} review`}
            tone="warning"
            action={{ content: "Review now", onAction: () => navigate("/app/bookings?status=needs_review") }}
          >
            <p>
              Orders came in for dates that would exceed your available units. Reach out to those customers to adjust dates or refund, otherwise you may end up overbooked.
            </p>
          </Banner>
        )}

        {overdueCount > 0 && (
          <Banner
            title={`${overdueCount} rental${overdueCount > 1 ? "s are" : " is"} overdue`}
            tone="critical"
            action={{ content: "Review overdue bookings", onAction: () => navigate("/app/bookings?status=overdue") }}
          >
            <p>These items have not been returned past their due date. Contact the customers and apply late fees if needed.</p>
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
                  <Text as="h2" variant="headingMd">Recent bookings</Text>
                  <Button variant="plain" onClick={() => navigate("/app/bookings")}>
                    View all
                  </Button>
                </InlineStack>
                {recentBookings.length === 0 ? (
                  <EmptyState
                    heading="No bookings yet"
                    image=""
                  >
                    <p>Once customers rent products, their bookings will appear here.</p>
                  </EmptyState>
                ) : (
                  <DataTable
                    columnContentTypes={["text","text","text","text","text","numeric","text"]}
                    headings={["Order","Customer","Product","Start date","Return by","Charged","Status"]}
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
                <Text as="h2" variant="headingMd">Upcoming rentals</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Confirmed bookings starting soon
                </Text>
                {upcomingBookings.length === 0 ? (
                  <Text as="p" tone="subdued">No upcoming rentals.</Text>
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
                                  ? "Starts today"
                                  : isTomorrow(new Date(b.startDate))
                                  ? "Starts tomorrow"
                                  : format(new Date(b.startDate), "d MMM")}
                              </Badge>
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">{b.productTitle}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              Returns {format(new Date(b.endDate), "d MMM yyyy")}
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
      </BlockStack>
    </Page>
  );
}
