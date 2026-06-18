import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Select,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isSameDay, isSameMonth, addMonths, subMonths, isToday } from "date-fns";
import { useState } from "react";
import { useNavigate as useNav } from "@remix-run/react";

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
    <Page
      title="Availability Calendar"
      subtitle="See all rental bookings at a glance. Click any booking to view details."
    >
      <BlockStack gap="500">
        {/* Controls */}
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="300" blockAlign="center">
              <Button onClick={() => changeMonth(-1)}>← Previous</Button>
              <Text as="h2" variant="headingLg">
                {format(currentDate, "MMMM yyyy")}
              </Text>
              <Button onClick={() => changeMonth(1)}>Next →</Button>
            </InlineStack>
            <Box minWidth="220px">
              <Select
                label="Filter by product"
                labelInline
                options={[
                  { label: "All products", value: "" },
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
            </Box>
          </InlineStack>
        </Card>

        {/* Legend */}
        <InlineStack gap="400" wrap>
          {Object.entries(STATUS_COLORS).map(([status, color]) => (
            <InlineStack key={status} gap="150" blockAlign="center">
              <Box
                background="bg-surface"
                borderRadius="100"
                minWidth="14px"
                minHeight="14px"
                borderWidth="025"
                borderColor="border"
                padding="0"
              >
                <div style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: color }} />
              </Box>
              <Text as="span" variant="bodySm" tone="subdued">
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </Text>
            </InlineStack>
          ))}
        </InlineStack>

        {/* Calendar grid */}
        <Card padding="0">
          <Box padding="400">
            {/* Day headers */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px", marginBottom: "4px" }}>
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (
                <div key={d} style={{ textAlign: "center", padding: "8px 4px" }}>
                  <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">{d}</Text>
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
                      border: isCurrentDay ? "2px solid #6366f1" : "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: "6px 8px",
                      backgroundColor: isCurrentDay ? "#eef2ff" : "white",
                    }}
                  >
                    <Text
                      as="p"
                      variant="bodySm"
                      fontWeight={isCurrentDay ? "bold" : "regular"}
                      tone={isCurrentDay ? undefined : "subdued"}
                    >
                      {format(day, "d")}
                    </Text>
                    <BlockStack gap="100">
                      {dayBookings.slice(0, 3).map((b) => (
                        <button
                          key={b.id}
                          onClick={() => navigate(`/app/bookings/${b.id}`)}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            background: STATUS_COLORS[b.status] || "#e5e7eb",
                            border: "none",
                            borderRadius: 4,
                            padding: "2px 6px",
                            cursor: "pointer",
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
                        <Text as="p" variant="bodySm" tone="subdued">
                          +{dayBookings.length - 3} more
                        </Text>
                      )}
                    </BlockStack>
                  </div>
                );
              })}
            </div>
          </Box>
        </Card>
      </BlockStack>
    </Page>
  );
}
