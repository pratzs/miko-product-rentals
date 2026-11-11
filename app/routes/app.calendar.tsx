import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isSameDay, isSameMonth, addMonths, subMonths, isToday } from "date-fns";
import { Select } from "../components/polaris";
import { useT } from "../i18n/context";

const STATUS_COLORS: Record<string, string> = {
  confirmed:    "#b3d4ff",
  active:       "#b5f5c8",
  overdue:      "#ffb3b3",
  returned:     "#d4d4d4",
  needs_review: "#fde68a",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const productFilter = url.searchParams.get("productId") || "";
  const year = parseInt(url.searchParams.get("year") || String(new Date().getFullYear()));
  const month = parseInt(url.searchParams.get("month") || String(new Date().getMonth() + 1));

  const from = startOfMonth(new Date(year, month - 1));
  const to = endOfMonth(new Date(year, month - 1));

  const [products, bookings] = await Promise.all([
    db.rentalProduct.findMany({ where: { shop }, select: { id: true, shopifyProductTitle: true } }),
    db.rentalBooking.findMany({
      where: {
        shop,
        ...(productFilter ? { rentalProductId: productFilter } : {}),
        status: { in: ["confirmed", "active", "overdue", "returned", "needs_review"] },
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: { rentalProduct: true },
    }),
  ]);

  return json({
    products: products.map((p) => ({ id: p.id, title: p.shopifyProductTitle })),
    bookings: bookings.map((b) => ({
      id: b.id,
      customerName: b.customerName,
      productTitle: b.rentalProduct.shopifyProductTitle,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      status: b.status,
      orderName: b.shopifyOrderName,
    })),
    year,
    month,
  });
};

export default function CalendarPage() {
  const { bookings, products, year, month } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();

  const currentDate = new Date(year, month - 1);
  const days = eachDayOfInterval({
    start: startOfMonth(currentDate),
    end: endOfMonth(currentDate),
  });

  const firstDayOfWeek = getDay(startOfMonth(currentDate));
  const blanks = Array(firstDayOfWeek).fill(null);

  function changeMonth(delta: number) {
    const newDate = delta > 0 ? addMonths(currentDate, 1) : subMonths(currentDate, 1);
    setSearchParams((p) => {
      p.set("year", String(newDate.getFullYear()));
      p.set("month", String(newDate.getMonth() + 1));
      return p;
    });
  }

  function getBookingsForDay(day: Date) {
    return bookings.filter((b) => {
      const start = new Date(b.startDate);
      const end = new Date(b.endDate);
      return day >= start && day < end;
    });
  }

  const productFilter = searchParams.get("productId") || "";

  return (
    <s-page heading={t("Availability Calendar")} inlineSize="large">
      <s-stack direction="block" gap="large">
        <s-text color="subdued">
          {t("See all rental bookings at a glance. Click any booking to view details.")}
        </s-text>

        {/* Controls */}
        <s-section accessibilityLabel={t("Availability Calendar")}>
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
            gap="base"
          >
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button onClick={() => changeMonth(-1)}>{t("← Previous")}</s-button>
              <s-heading>{format(currentDate, "MMMM yyyy")}</s-heading>
              <s-button onClick={() => changeMonth(1)}>{t("Next →")}</s-button>
            </s-stack>
            <s-box minInlineSize="220px">
              <Select
                label={t("Filter by product")}
                options={[
                  { label: t("All products"), value: "" },
                  ...products.map((p) => ({ label: p.title, value: p.id })),
                ]}
                value={productFilter}
                onChange={(v) => {
                  setSearchParams((p) => {
                    if (v) p.set("productId", v);
                    else p.delete("productId");
                    return p;
                  });
                }}
              />
            </s-box>
          </s-stack>
        </s-section>

        {/* Legend */}
        <s-stack direction="inline" gap="base">
          {Object.entries(STATUS_COLORS).map(([status, color]) => (
            <s-stack key={status} direction="inline" gap="small-200" alignItems="center">
              <div
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  backgroundColor: color,
                  boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.1)",
                }}
              />
              <s-text color="subdued">
                {t(status === "needs_review" ? "Needs review" : status.charAt(0).toUpperCase() + status.slice(1))}
              </s-text>
            </s-stack>
          ))}
        </s-stack>

        {/* Calendar grid. Hand-drawn on purpose: Polaris has no month grid with
            per-day booking chips. Neutral borders and currentColor so it sits
            on either admin look; the pastel status colours are the legend. */}
        <s-section padding="none" accessibilityLabel={format(currentDate, "MMMM yyyy")}>
          <s-box padding="base">
            {/* Day headers */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px", marginBottom: "4px" }}>
              {[t("Sun"), t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat")].map((d) => (
                <div key={d} style={{ textAlign: "center", padding: "8px 4px" }}>
                  <s-text color="subdued" fontWeight="semibold">{d}</s-text>
                </div>
              ))}
            </div>

            {/* Day cells */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px" }}>
              {blanks.map((_, i) => (
                <div key={`blank-${i}`} style={{ minHeight: 100 }} />
              ))}

              {days.map((day) => {
                const dayBookings = getBookingsForDay(day);
                const isCurrentDay = isToday(day);

                return (
                  <div
                    key={day.toISOString()}
                    style={{
                      minHeight: 100,
                      border: isCurrentDay ? "2px solid currentColor" : "1px solid rgba(0, 0, 0, 0.1)",
                      borderRadius: 8,
                      padding: "6px 8px",
                      backgroundColor: "#ffffff",
                    }}
                  >
                    <s-paragraph
                      fontWeight={isCurrentDay ? "bold" : undefined}
                      color={isCurrentDay ? undefined : "subdued"}
                    >
                      {format(day, "d")}
                    </s-paragraph>
                    <s-stack direction="block" gap="small-300">
                      {dayBookings.slice(0, 3).map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => navigate(`/app/bookings/${b.id}`)}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            background: STATUS_COLORS[b.status] || "rgba(0, 0, 0, 0.06)",
                            border: "none",
                            borderRadius: 4,
                            padding: "2px 6px",
                            cursor: "pointer",
                            color: "inherit",
                            font: "inherit",
                            fontSize: 11,
                            lineHeight: "18px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={`${b.customerName} - ${b.productTitle}`}
                        >
                          {b.customerName.split(" ")[0]}
                        </button>
                      ))}
                      {dayBookings.length > 3 && (
                        <s-text color="subdued">
                          {t("+{n} more", { n: dayBookings.length - 3 })}
                        </s-text>
                      )}
                    </s-stack>
                  </div>
                );
              })}
            </div>
          </s-box>
        </s-section>
      </s-stack>
    </s-page>
  );
}
