import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  DataTable,
  EmptyState,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, isToday, isTomorrow, isPast, addDays } from "date-fns";
import { formatCurrency } from "../utils/pricing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, totalProducts, bookings] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalProduct.count({ where: { shop, isActive: true } }),
    db.rentalBooking.findMany({
      where: { shop },
      include: { rentalProduct: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

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

  return json({
    shop,
    currency: config?.currency || "USD",
    onboardingCompleted: config?.onboardingCompleted || false,
    stats: {
      totalProducts,
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
  const { stats, upcomingBookings, recentBookings, currency, onboardingCompleted, overdueCount } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();

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
    b.orderName || "—",
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
        {!onboardingCompleted && stats.totalProducts === 0 && (
          <Banner
            title="Set up your first rental product to get started"
            tone="info"
            action={{ content: "Go to Rental Products", onAction: () => navigate("/app/products") }}
          >
            <p>
              Add any product from your Shopify store to Miko Rentals, set your pricing and deposit,
              and a booking calendar will appear on that product page automatically.
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
        <Layout>
          {statCards.map((card) => (
            <Layout.Section key={card.label} variant="oneQuarter">
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" tone="subdued">{card.label}</Text>
                  <Text as="p" variant="headingXl" fontWeight="bold">{card.value}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{card.sublabel}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          ))}
        </Layout>

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
                        <Box paddingBlockStart={i > 0 ? "300" : "000"}>
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
