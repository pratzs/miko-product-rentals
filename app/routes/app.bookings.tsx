import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
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
  Filters,
  ChoiceList,
  Select,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { useState, useCallback } from "react";

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
  pending:   { tone: "attention", label: "Pending payment" },
  confirmed: { tone: "info",      label: "Confirmed" },
  active:    { tone: "success",   label: "Out on rental" },
  returned:  { tone: "success",   label: "Returned" },
  overdue:   { tone: "critical",  label: "Overdue" },
  cancelled: { tone: "subdued",   label: "Cancelled" },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") || "";
  const productFilter = url.searchParams.get("productId") || "";
  const search = url.searchParams.get("q") || "";

  const [config, bookings, products] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalBooking.findMany({
      where: {
        shop,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(productFilter ? { rentalProductId: productFilter } : {}),
        ...(search
          ? {
              OR: [
                { customerName: { contains: search, mode: "insensitive" } },
                { customerEmail: { contains: search, mode: "insensitive" } },
                { shopifyOrderName: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { rentalProduct: true },
      orderBy: { createdAt: "desc" },
    }),
    db.rentalProduct.findMany({ where: { shop }, select: { id: true, shopifyProductTitle: true } }),
  ]);

  return json({
    currency: config?.currency || "USD",
    bookings: bookings.map((b) => ({
      id: b.id,
      customerName: b.customerName,
      customerEmail: b.customerEmail,
      productTitle: b.rentalProduct.shopifyProductTitle,
      productId: b.rentalProductId,
      orderName: b.shopifyOrderName,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      rentalDays: b.rentalDays,
      status: b.status,
      totalCharged: b.totalCharged,
      depositStatus: b.depositStatus,
    })),
    products: products.map((p) => ({ id: p.id, title: p.shopifyProductTitle })),
    counts: {
      all: bookings.length,
      active: bookings.filter((b) => b.status === "active").length,
      overdue: bookings.filter((b) => b.status === "overdue").length,
      confirmed: bookings.filter((b) => b.status === "confirmed").length,
    },
  });
};

export default function BookingsPage() {
  const { bookings, products, currency, counts } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryValue, setQueryValue] = useState(searchParams.get("q") || "");
  const statusFilter = searchParams.get("status") || "";

  function applyFilter(key: string, value: string) {
    const p = new URLSearchParams(searchParams);
    if (value) p.set(key, value);
    else p.delete(key);
    setSearchParams(p);
  }

  function handleSearch(v: string) {
    setQueryValue(v);
    const p = new URLSearchParams(searchParams);
    if (v) p.set("q", v);
    else p.delete("q");
    setSearchParams(p);
  }

  const rows = bookings.map((b) => [
    <Button variant="plain" onClick={() => navigate(`/app/bookings/${b.id}`)}>
      {b.orderName || b.id.slice(-6).toUpperCase()}
    </Button>,
    <BlockStack gap="050">
      <Text as="p" variant="bodyMd">{b.customerName}</Text>
      <Text as="p" variant="bodySm" tone="subdued">{b.customerEmail}</Text>
    </BlockStack>,
    b.productTitle,
    format(new Date(b.startDate), "d MMM yyyy"),
    format(new Date(b.endDate), "d MMM yyyy"),
    `${b.rentalDays}d`,
    formatCurrency(b.totalCharged, currency),
    <Badge tone={STATUS_BADGE[b.status]?.tone}>{STATUS_BADGE[b.status]?.label}</Badge>,
  ]);

  const statusTabs = [
    { label: "All", value: "", count: counts.all },
    { label: "Active", value: "active", count: counts.active },
    { label: "Overdue", value: "overdue", count: counts.overdue },
    { label: "Confirmed", value: "confirmed", count: counts.confirmed },
  ];

  return (
    <Page
      title="Bookings"
      subtitle="Every rental booking across all your products"
    >
      <BlockStack gap="500">
        {/* Tab-style status pills */}
        <InlineStack gap="200">
          {statusTabs.map((tab) => (
            <Button
              key={tab.value}
              variant={statusFilter === tab.value ? "primary" : "secondary"}
              onClick={() => applyFilter("status", tab.value)}
              size="slim"
            >
              {tab.label} ({tab.count})
            </Button>
          ))}
        </InlineStack>

        <Card padding="0">
          <Box padding="400">
            <Filters
              queryValue={queryValue}
              queryPlaceholder="Search by customer name, email, or order number"
              onQueryChange={handleSearch}
              onQueryClear={() => handleSearch("")}
              filters={[
                {
                  key: "productId",
                  label: "Product",
                  filter: (
                    <ChoiceList
                      title="Product"
                      titleHidden
                      choices={[
                        { label: "All products", value: "" },
                        ...products.map((p) => ({ label: p.title, value: p.id })),
                      ]}
                      selected={[searchParams.get("productId") || ""]}
                      onChange={([v]) => applyFilter("productId", v)}
                    />
                  ),
                },
              ]}
              onClearAll={() => setSearchParams({})}
            />
          </Box>

          {bookings.length === 0 ? (
            <Box padding="800">
              <EmptyState heading="No bookings match your filters" image="">
                <p>Try adjusting the filters or search term.</p>
              </EmptyState>
            </Box>
          ) : (
            <DataTable
              columnContentTypes={["text","text","text","text","text","text","numeric","text"]}
              headings={["Order","Customer","Product","Start date","Return by","Duration","Charged","Status"]}
              rows={rows}
              hoverable
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
