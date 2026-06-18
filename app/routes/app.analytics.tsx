import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Box,
  Divider,
  DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, startOfMonth, endOfMonth, subMonths, startOfYear } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from "recharts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await db.shopConfig.findUnique({ where: { shop } });
  const currency = config?.currency || "USD";

  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const thisMonthEnd = endOfMonth(now);
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const lastMonthEnd = endOfMonth(subMonths(now, 1));
  const yearStart = startOfYear(now);

  const [
    allBookings,
    thisMonthBookings,
    lastMonthBookings,
    productStats,
    depositSummary,
  ] = await Promise.all([
    db.rentalBooking.findMany({
      where: { shop, status: { in: ["confirmed", "active", "returned", "overdue"] } },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        rentalPrice: true,
        depositAmount: true,
        status: true,
        rentalDays: true,
        startDate: true,
        endDate: true,
      },
    }),
    db.rentalBooking.findMany({
      where: { shop, status: { notIn: ["cancelled", "pending"] }, createdAt: { gte: thisMonthStart, lte: thisMonthEnd } },
      select: { rentalPrice: true, depositAmount: true },
    }),
    db.rentalBooking.findMany({
      where: { shop, status: { notIn: ["cancelled", "pending"] }, createdAt: { gte: lastMonthStart, lte: lastMonthEnd } },
      select: { rentalPrice: true },
    }),
    db.rentalProduct.findMany({
      where: { shop },
      select: {
        id: true,
        shopifyProductTitle: true,
        isActive: true,
        _count: { select: { bookings: true } },
        bookings: {
          where: { status: { notIn: ["cancelled", "pending"] } },
          select: { rentalPrice: true, rentalDays: true },
        },
      },
    }),
    db.rentalBooking.findMany({
      where: { shop, depositStatus: "held", status: { notIn: ["cancelled"] } },
      select: { depositAmount: true },
    }),
  ]);

  // Revenue = rental fees only (deposit is a liability we owe back, not revenue).
  const thisMonthRevenue = thisMonthBookings.reduce((s, b) => s + b.rentalPrice, 0);
  const lastMonthRevenue = lastMonthBookings.reduce((s, b) => s + b.rentalPrice, 0);
  const totalRevenue = allBookings.reduce((s, b) => s + b.rentalPrice, 0);
  const totalBookings = allBookings.length;
  const avgOrderValue = totalBookings > 0 ? totalRevenue / totalBookings : 0;
  const avgRentalDays = totalBookings > 0
    ? allBookings.reduce((s, b) => s + b.rentalDays, 0) / totalBookings
    : 0;

  // Auto-classify by date so the picture is accurate even when the daily cron
  // hasn't run yet. A confirmed booking whose start date has arrived is really
  // active right now; an active booking past its end date is really overdue.
  const realActive = allBookings.filter(
    (b) =>
      (b.status === "active" || b.status === "confirmed") &&
      b.startDate <= now &&
      b.endDate >= now,
  ).length;
  const realOverdue = allBookings.filter(
    (b) =>
      b.status !== "returned" &&
      b.status !== "cancelled" &&
      b.endDate < now,
  ).length;

  const depositsHeld = depositSummary.reduce((s, b) => s + b.depositAmount, 0);
  const depositsHeldCount = depositSummary.length;

  // Monthly revenue for the last 6 months (rental fees only)
  const monthlyRevenue = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(now, 5 - i);
    const mStart = startOfMonth(d);
    const mEnd = endOfMonth(d);
    const rev = allBookings
      .filter((b) => b.createdAt >= mStart && b.createdAt <= mEnd)
      .reduce((s, b) => s + b.rentalPrice, 0);
    return { month: format(d, "MMM"), revenue: Math.round(rev * 100) / 100 };
  });

  // Booking volume per month for last 6 months
  const monthlyBookings = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(now, 5 - i);
    const mStart = startOfMonth(d);
    const mEnd = endOfMonth(d);
    const count = allBookings.filter((b) => b.createdAt >= mStart && b.createdAt <= mEnd).length;
    return { month: format(d, "MMM"), bookings: count };
  });

  // Top products by revenue (rental fees only)
  const topProducts = productStats
    .map((p) => ({
      id: p.id,
      title: p.shopifyProductTitle,
      isActive: p.isActive,
      bookings: p._count.bookings,
      revenue: p.bookings.reduce((s, b) => s + b.rentalPrice, 0),
      avgDays: p.bookings.length > 0
        ? Math.round(p.bookings.reduce((s, b) => s + b.rentalDays, 0) / p.bookings.length)
        : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return json({
    currency,
    stats: {
      thisMonthRevenue,
      lastMonthRevenue,
      totalRevenue,
      totalBookings,
      avgOrderValue,
      avgRentalDays: Math.round(avgRentalDays * 10) / 10,
      activeCount: realActive,
      overdueCount: realOverdue,
      depositsHeld,
      depositsHeldCount,
    },
    monthlyRevenue,
    monthlyBookings,
    topProducts,
  });
};

function StatCard({
  label,
  value,
  subtext,
  tone,
}: {
  label: string;
  value: string;
  subtext?: string;
  tone?: "success" | "critical" | "subdued";
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingXl">{value}</Text>
        {subtext && (
          <Text as="p" variant="bodySm" tone={tone || "subdued"}>{subtext}</Text>
        )}
      </BlockStack>
    </Card>
  );
}

export default function AnalyticsPage() {
  const { currency, stats, monthlyRevenue, monthlyBookings, topProducts } =
    useLoaderData<typeof loader>();

  const revenueDelta = stats.lastMonthRevenue > 0
    ? ((stats.thisMonthRevenue - stats.lastMonthRevenue) / stats.lastMonthRevenue) * 100
    : null;

  const topProductRows = topProducts.map((p) => [
    <InlineStack gap="200" blockAlign="center" key={p.id}>
      <Text as="span">{p.title}</Text>
      {p.isActive && <Badge tone="success">Active</Badge>}
    </InlineStack>,
    String(p.bookings),
    formatCurrency(p.revenue, currency),
    formatCurrency(p.bookings > 0 ? p.revenue / p.bookings : 0, currency),
    `${p.avgDays}d`,
  ]);

  return (
    <Page
      title="Analytics"
      subtitle="Track how your rental business is performing over time."
    >
      <BlockStack gap="600">
        {/* Top stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          <StatCard
            label="Revenue this month"
            value={formatCurrency(stats.thisMonthRevenue, currency)}
            subtext={
              revenueDelta !== null
                ? `${revenueDelta >= 0 ? "+" : ""}${revenueDelta.toFixed(1)}% vs last month`
                : "No data for last month"
            }
            tone={revenueDelta !== null && revenueDelta >= 0 ? "success" : "critical"}
          />
          <StatCard
            label="Total revenue (all time)"
            value={formatCurrency(stats.totalRevenue, currency)}
            subtext={`Across ${stats.totalBookings} bookings`}
          />
          <StatCard
            label="Average booking value"
            value={formatCurrency(stats.avgOrderValue, currency)}
            subtext="Per confirmed booking"
          />
          <StatCard
            label="Average rental length"
            value={`${stats.avgRentalDays} days`}
            subtext="Per confirmed booking"
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          <StatCard
            label="Active rentals right now"
            value={String(stats.activeCount)}
            subtext="Currently out with customers"
            tone="success"
          />
          <StatCard
            label="Overdue returns"
            value={String(stats.overdueCount)}
            subtext={stats.overdueCount > 0 ? "Needs attention" : "All good"}
            tone={stats.overdueCount > 0 ? "critical" : "success"}
          />
          <StatCard
            label="Deposits held"
            value={formatCurrency(stats.depositsHeld, currency)}
            subtext={
              stats.depositsHeldCount > 0
                ? `Owed back across ${stats.depositsHeldCount} booking${stats.depositsHeldCount > 1 ? "s" : ""}`
                : "No outstanding deposits"
            }
          />
          <StatCard
            label="Total bookings (all time)"
            value={String(stats.totalBookings)}
            subtext={`${formatCurrency(stats.lastMonthRevenue, currency)} last month`}
          />
        </div>

        {/* Charts */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Monthly revenue - last 6 months</Text>
                <Divider />
                <div style={{ width: "100%", height: 240 }}>
                  <ResponsiveContainer>
                    <BarChart data={monthlyRevenue} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} tickFormatter={(v) => `${currency}${v}`} />
                      <Tooltip
                        formatter={(val: any) => [formatCurrency(val, currency), "Revenue"]}
                        contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 13 }}
                      />
                      <Bar dataKey="revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Booking volume - last 6 months</Text>
                <Divider />
                <div style={{ width: "100%", height: 240 }}>
                  <ResponsiveContainer>
                    <LineChart data={monthlyBookings} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} allowDecimals={false} />
                      <Tooltip
                        formatter={(val: any) => [val, "Bookings"]}
                        contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 13 }}
                      />
                      <Line type="monotone" dataKey="bookings" stroke="#10b981" strokeWidth={2} dot={{ r: 4, fill: "#10b981" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Top products */}
        <Card padding="0">
          <Box padding="400">
            <Text as="h2" variant="headingMd">Top products by revenue</Text>
          </Box>
          <Divider />
          {topProducts.length === 0 ? (
            <Box padding="800">
              <Text as="p" tone="subdued" alignment="center">No booking data yet. Revenue will appear here once you have confirmed bookings.</Text>
            </Box>
          ) : (
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
              headings={["Product", "Bookings", "Total revenue", "Avg per booking", "Avg rental length"]}
              rows={topProductRows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
