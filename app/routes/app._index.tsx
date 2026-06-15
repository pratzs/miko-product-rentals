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
import { CheckCircleIcon } from "@shopify/polaris-icons";
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
    emailReady: Boolean(config?.senderName && config.senderName.trim().length > 0),
  };
  const stepsDone = Object.values(steps).filter(Boolean).length;
  const allStepsDone = stepsDone === 4;

  // Auto-complete onboarding once every step is detected, so the checklist
  // disappears on its own without the merchant clicking anything.
  if (config && allStepsDone && !config.onboardingCompleted) {
    await db.shopConfig
      .update({ where: { shop }, data: { onboardingCompleted: true } })
      .catch(() => {});
  }

  const now = new Date();
  const activeBookings = bookings.filter((b) => b.status === "active");
  const overdueBookings = bookings.filter((b) => b.status === "overdue");
  const upcomingBookings = bookings
    .filter((b) => b.status === "confirmed" && b.startDate > now)
    .slice(0, 5);
  const returningTomorrow = bookings.filter(
    (b) =>
      (b.status === "active" || b.status === "overdue") &&
      isTomorrow(b.endDate),
  );
  const recentBookings = bookings.slice(0, 8);

  const totalRevenue = bookings
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + b.rentalPrice, 0);

  const thisMonthRevenue = bookings
    .filter((b) => {
      const d = new Date(b.createdAt);
      return (
        b.status !== "cancelled" &&
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear()
      );
    })
    .reduce((sum, b) => sum + b.rentalPrice, 0);

  const shopHandle = shop.replace(".myshopify.com", "");

  // Plan usage, so we can warn the merchant before bookings stop being created.
  const planName = config?.planName ?? "free";
  const limit = await checkRentalLimit(shop, planName, db);
  const planLabel = getPlan(planName).name;

  return json({
    shop,
    shopHandle,
    currency: config?.currency || "USD",
    onboardingCompleted: config?.onboardingCompleted || false,
    onboarding: { steps, stepsDone, allStepsDone },
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
      overdueBookings: overdueBookings.length,
      returningTomorrow: returningTomorrow.length,
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
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const themeEditorUrl = `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?template=product`;

  const setupSteps: {
    title: string;
    description: string;
    done: boolean;
    actionLabel: string;
    onAction?: () => void;
    url?: string;
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
      url: themeEditorUrl,
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
      label: "Active rentals",
      value: stats.activeBookings.toString(),
      sublabel: "Items currently out with customers",
      tone: "success" as const,
    },
    {
      label: "Overdue returns",
      value: stats.overdueBookings.toString(),
      sublabel: "Past the return date",
      tone: stats.overdueBookings > 0 ? ("critical" as const) : ("subdued" as const),
    },
    {
      label: "Revenue this month",
      value: formatCurrency(stats.thisMonthRevenue, currency),
      sublabel: `${formatCurrency(stats.totalRevenue, currency)} all time`,
      tone: "info" as const,
    },
    {
      label: "Rental products",
      value: stats.totalProducts.toString(),
      sublabel: `${stats.totalBookings} total bookings`,
      tone: "subdued" as const,
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
                    {`${onboarding.stepsDone} of 4 done`}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Work through these steps and your first product will be ready to rent. Each one ticks itself off as soon as we detect it is done, so there is nothing to mark by hand.
                </Text>
              </BlockStack>

              <ProgressBar progress={(onboarding.stepsDone / 4) * 100} tone="success" size="small" />

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
                          ) : step.url ? (
                            <Button url={step.url} external>{step.actionLabel}</Button>
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
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          {statCards.map((card) => (
            <Card key={card.label}>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">{card.label}</Text>
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
