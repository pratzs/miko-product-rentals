import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Grid } from "../components/polaris";
import { FOUR_UP, MAIN_WITH_SIDEBAR } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, startOfMonth, endOfMonth, subMonths, startOfYear } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { useT } from "../i18n/context";
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

// Chart styling. These charts are our own drawing, so they take the admin's
// text colour (`currentColor`) rather than hard-coding the previous Polaris
// palette, which would not follow the new admin look.
const CHART_TICK = { fontSize: 12, fill: "currentColor", fillOpacity: 0.65 };
const CHART_GRID = "rgba(0, 0, 0, 0.08)";
const CHART_TOOLTIP = { borderRadius: 8, border: "1px solid rgba(0, 0, 0, 0.1)", fontSize: 13 };

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
    <s-section>
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-text fontSize="large-100" fontWeight="bold">{value}</s-text>
        {subtext && (
          !tone || tone === "subdued" ? (
            <s-text color="subdued">{subtext}</s-text>
          ) : (
            <s-text tone={tone}>{subtext}</s-text>
          )
        )}
      </s-stack>
    </s-section>
  );
}

export default function AnalyticsPage() {
  const { currency, stats, monthlyRevenue, monthlyBookings, topProducts } =
    useLoaderData<typeof loader>();
  const t = useT();

  const revenueDelta = stats.lastMonthRevenue > 0
    ? ((stats.thisMonthRevenue - stats.lastMonthRevenue) / stats.lastMonthRevenue) * 100
    : null;

  return (
    <s-page heading={t("Analytics")} inlineSize="large">
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Track how your rental business is performing over time.")}</s-text>

        {/* Top stats */}
        <Grid columns={FOUR_UP} gap="base">
          <StatCard
            label={t("Revenue this month")}
            value={formatCurrency(stats.thisMonthRevenue, currency)}
            subtext={
              revenueDelta !== null
                ? t("{delta}% vs last month", {
                    delta: `${revenueDelta >= 0 ? "+" : ""}${revenueDelta.toFixed(1)}`,
                  })
                : t("No data for last month")
            }
            tone={revenueDelta !== null && revenueDelta >= 0 ? "success" : "critical"}
          />
          <StatCard
            label={t("Total revenue (all time)")}
            value={formatCurrency(stats.totalRevenue, currency)}
            subtext={t("Across {n} bookings", { n: stats.totalBookings })}
          />
          <StatCard
            label={t("Average booking value")}
            value={formatCurrency(stats.avgOrderValue, currency)}
            subtext={t("Per confirmed booking")}
          />
          <StatCard
            label={t("Average rental length")}
            value={t("{n} days", { n: stats.avgRentalDays })}
            subtext={t("Per confirmed booking")}
          />
        </Grid>

        <Grid columns={FOUR_UP} gap="base">
          <StatCard
            label={t("Active rentals right now")}
            value={String(stats.activeCount)}
            subtext={t("Currently out with customers")}
            tone="success"
          />
          <StatCard
            label={t("Overdue returns")}
            value={String(stats.overdueCount)}
            subtext={stats.overdueCount > 0 ? t("Needs attention") : t("All good")}
            tone={stats.overdueCount > 0 ? "critical" : "success"}
          />
          <StatCard
            label={t("Deposits held")}
            value={formatCurrency(stats.depositsHeld, currency)}
            subtext={
              stats.depositsHeldCount > 0
                ? stats.depositsHeldCount > 1
                  ? t("Owed back across {n} bookings", { n: stats.depositsHeldCount })
                  : t("Owed back across {n} booking", { n: stats.depositsHeldCount })
                : t("No outstanding deposits")
            }
          />
          <StatCard
            label={t("Total bookings (all time)")}
            value={String(stats.totalBookings)}
            subtext={t("{amount} last month", {
              amount: formatCurrency(stats.lastMonthRevenue, currency),
            })}
          />
        </Grid>

        {/* Charts */}
        <Grid columns={MAIN_WITH_SIDEBAR} gap="base">
          <s-section heading={t("Monthly revenue (last 6 months)")}>
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={monthlyRevenue} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false} tick={CHART_TICK} />
                  <YAxis axisLine={false} tickLine={false} tick={CHART_TICK} tickFormatter={(v) => `${currency}${v}`} />
                  <Tooltip
                    formatter={(val: any) => [formatCurrency(val, currency), t("Revenue")]}
                    contentStyle={CHART_TOOLTIP}
                  />
                  <Bar dataKey="revenue" fill="currentColor" fillOpacity={0.8} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </s-section>

          <s-section heading={t("Booking volume (last 6 months)")}>
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={monthlyBookings} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false} tick={CHART_TICK} />
                  <YAxis axisLine={false} tickLine={false} tick={CHART_TICK} allowDecimals={false} />
                  <Tooltip
                    formatter={(val: any) => [val, t("Bookings")]}
                    contentStyle={CHART_TOOLTIP}
                  />
                  <Line type="monotone" dataKey="bookings" stroke="currentColor" strokeWidth={2} dot={{ r: 4, fill: "currentColor" }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </s-section>
        </Grid>

        {/* Top products */}
        <s-section padding="none" accessibilityLabel={t("Top products by revenue")}>
          <s-box padding="base">
            <s-heading>{t("Top products by revenue")}</s-heading>
          </s-box>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Product")}</s-table-header>
              <s-table-header format="numeric">{t("Bookings")}</s-table-header>
              <s-table-header format="currency">{t("Total revenue")}</s-table-header>
              <s-table-header format="currency">{t("Avg per booking")}</s-table-header>
              <s-table-header format="numeric">{t("Avg rental length")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {topProducts.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-text>{p.title}</s-text>
                      {p.isActive && <s-badge tone="success">{t("Active")}</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{String(p.bookings)}</s-table-cell>
                  <s-table-cell>{formatCurrency(p.revenue, currency)}</s-table-cell>
                  <s-table-cell>{formatCurrency(p.bookings > 0 ? p.revenue / p.bookings : 0, currency)}</s-table-cell>
                  <s-table-cell>{t("{days}d", { days: p.avgDays })}</s-table-cell>
                </s-table-row>
              ))}
              <s-empty-state heading={t("Top products by revenue")}>
                <s-text slot="subheading">{t("No booking data yet. Revenue will appear here once you have confirmed bookings.")}</s-text>
              </s-empty-state>
            </s-table-body>
          </s-table>
        </s-section>
      </s-stack>
    </s-page>
  );
}
