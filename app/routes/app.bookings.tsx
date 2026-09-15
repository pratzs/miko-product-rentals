import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, Form } from "@remix-run/react";
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
import { Banner } from "@shopify/polaris";
import { useT } from "../i18n/context";

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
  pending:      { tone: "attention", label: "Pending payment" },
  confirmed:    { tone: "info",      label: "Confirmed" },
  active:       { tone: "success",   label: "Out on rental" },
  returned:     { tone: "success",   label: "Returned" },
  overdue:      { tone: "critical",  label: "Overdue" },
  cancelled:    { tone: "subdued",   label: "Canceled" },
  needs_review: { tone: "warning",   label: "Needs review" },
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
      include: { rentalProduct: true, rentalVariant: true },
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
      variantTitle: b.rentalVariant?.shopifyVariantTitle ?? null,
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
      needs_review: bookings.filter((b) => b.status === "needs_review").length,
    },
  });
};

export default function BookingsPage() {
  const { bookings, products, currency, counts } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const t = useT();
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
    <BlockStack gap="050">
      <Text as="p" variant="bodyMd">{b.productTitle}</Text>
      {b.variantTitle && (
        <Text as="p" variant="bodySm" tone="subdued">{b.variantTitle}</Text>
      )}
    </BlockStack>,
    format(new Date(b.startDate), "d MMM yyyy"),
    format(new Date(b.endDate), "d MMM yyyy"),
    `${b.rentalDays}d`,
    formatCurrency(b.totalCharged, currency),
    <Badge tone={STATUS_BADGE[b.status]?.tone}>{t(STATUS_BADGE[b.status]?.label ?? "")}</Badge>,
  ]);

  const statusTabs = [
    { label: t("All"), value: "", count: counts.all },
    { label: t("Needs review"), value: "needs_review", count: counts.needs_review },
    { label: t("Active"), value: "active", count: counts.active },
    { label: t("Overdue"), value: "overdue", count: counts.overdue },
    { label: t("Confirmed"), value: "confirmed", count: counts.confirmed },
  ];

  const syncedCount = parseInt(searchParams.get("synced") || "0");
  const upgradedCount = parseInt(searchParams.get("upgraded") || "0");
  const flaggedCount = parseInt(searchParams.get("flagged") || "0");
  const showSyncBanner = syncedCount > 0 || upgradedCount > 0 || flaggedCount > 0;

  return (
    <Page
      title={t("Bookings")}
      subtitle={t("Every rental booking across all your products")}
      secondaryActions={[
        {
          content: t("Sync from Shopify"),
          helpText: t("Recover bookings from recent Shopify orders that may have been missed"),
        },
      ]}
    >
      <BlockStack gap="500">
        {showSyncBanner && (
          <Banner
            tone={flaggedCount > 0 ? "warning" : "success"}
            title={t("Sync complete")}
            onDismiss={() => {
              const p = new URLSearchParams(searchParams);
              p.delete("synced");
              p.delete("upgraded");
              p.delete("flagged");
              setSearchParams(p);
            }}
          >
            <p>
              {syncedCount > 0 && (
                <>
                  {syncedCount > 1
                    ? t("Created {n} new bookings.", { n: syncedCount })
                    : t("Created {n} new booking.", { n: syncedCount })}{" "}
                </>
              )}
              {upgradedCount > 0 && (
                <>
                  {upgradedCount > 1
                    ? t("Upgraded {n} pending bookings to confirmed.", { n: upgradedCount })
                    : t("Upgraded {n} pending booking to confirmed.", { n: upgradedCount })}{" "}
                </>
              )}
              {flaggedCount > 0 &&
                (flaggedCount > 1
                  ? t("{n} bookings were flagged for review (overbooking risk).", { n: flaggedCount })
                  : t("{n} booking was flagged for review (overbooking risk).", { n: flaggedCount }))}
            </p>
          </Banner>
        )}

        <Form method="POST" action="/app/sync-orders">
          <input type="hidden" name="returnTo" value="/app/bookings" />
          <Button submit variant="plain">
            {t("Sync from Shopify (recover missing bookings)")}
          </Button>
        </Form>

        {/* Tab-style status pills */}
        <InlineStack gap="200">
          {statusTabs.map((tab) => (
            <Button
              key={tab.value}
              variant={statusFilter === tab.value ? "primary" : "secondary"}
              onClick={() => applyFilter("status", tab.value)}
              size="slim"
            >
              {`${tab.label} (${tab.count})`}
            </Button>
          ))}
        </InlineStack>

        <Card padding="0">
          <Box padding="400">
            <Filters
              queryValue={queryValue}
              queryPlaceholder={t("Search by customer name, email, or order number")}
              onQueryChange={handleSearch}
              onQueryClear={() => handleSearch("")}
              filters={[
                {
                  key: "productId",
                  label: t("Product"),
                  filter: (
                    <ChoiceList
                      title={t("Product")}
                      titleHidden
                      choices={[
                        { label: t("All products"), value: "" },
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
              <EmptyState heading={t("No bookings match your filters")} image="">
                <p>{t("Try adjusting the filters or search term.")}</p>
              </EmptyState>
            </Box>
          ) : (
            <DataTable
              columnContentTypes={["text","text","text","text","text","text","numeric","text"]}
              headings={[t("Order"), t("Customer"), t("Product"), t("Start date"), t("Return by"), t("Duration"), t("Charged"), t("Status")]}
              rows={rows}
              hoverable
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
