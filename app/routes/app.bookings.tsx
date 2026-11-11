import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, Form } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { useRef, useState } from "react";
import type { ElementRef } from "react";
import { Banner, Button, Select, badgeTone, useCustomEvent } from "../components/polaris";
import { AskSidekickButton } from "../components/AskSidekick";
import { useT } from "../i18n/context";

const STATUS_BADGE: Record<string, { tone: string; label: string }> = {
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

  // s-search-field's `input` is a Polaris event; React 18 needs the listener
  // attached by hand. Fires per keystroke, as Polaris React's Filters did.
  const searchRef = useRef<ElementRef<"s-search-field">>(null);
  useCustomEvent(searchRef, "input", (e) => {
    handleSearch(String((e.currentTarget as unknown as { value?: string }).value ?? ""));
  });

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
  const hasFilters = !!(searchParams.get("q") || searchParams.get("productId") || statusFilter);

  return (
    <s-page heading={t("Bookings")} inlineSize="large">
      {/* Ask Sidekick (plan 9.3). Hidden unless shopify.sidekick.isEnabled()
          says yes; launches only on click. Answered by the read-only
          list_overdue_rentals tool in extensions/rentals-sidekick. */}
      <AskSidekickButton
        slot="secondary-actions"
        label={t("Ask Sidekick")}
        prompt={t("Which rentals are overdue right now, who has them, and how late is each one?")}
        errors={{
          rejected: t("Sidekick could not take that question."),
          failed: t("Sidekick could not start the conversation."),
        }}
      />
      <s-stack direction="block" gap="base">
        <s-text color="subdued">{t("Every rental booking across all your products")}</s-text>

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
            <s-paragraph>
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
            </s-paragraph>
          </Banner>
        )}

        <Form method="POST" action="/app/sync-orders">
          <input type="hidden" name="returnTo" value="/app/bookings" />
          <s-button type="submit" variant="tertiary">
            {t("Sync from Shopify (recover missing bookings)")}
          </s-button>
        </Form>

        {/* Tab-style status pills */}
        <s-stack direction="inline" gap="small-200">
          {statusTabs.map((tab) => (
            <s-button
              key={tab.value}
              variant={statusFilter === tab.value ? "primary" : "secondary"}
              onClick={() => applyFilter("status", tab.value)}
            >
              {`${tab.label} (${tab.count})`}
            </s-button>
          ))}
        </s-stack>

        <s-section padding="none" accessibilityLabel={t("Bookings")}>
          <s-table>
            <s-stack slot="filters" direction="inline" gap="small-200" alignItems="end">
              <s-box inlineSize="100%" maxInlineSize="420px">
                <s-search-field
                  ref={searchRef}
                  label={t("Search")}
                  labelAccessibilityVisibility="exclusive"
                  placeholder={t("Search by customer name, email, or order number")}
                  value={queryValue}
                />
              </s-box>
              <s-box minInlineSize="200px">
                <Select
                  label={t("Product")}
                  value={searchParams.get("productId") || ""}
                  onChange={(v) => applyFilter("productId", v)}
                  options={[
                    { label: t("All products"), value: "" },
                    ...products.map((p) => ({ label: p.title, value: p.id })),
                  ]}
                />
              </s-box>
              {hasFilters && (
                <s-button variant="tertiary" onClick={() => { setQueryValue(""); setSearchParams({}); }}>
                  {t("Clear all")}
                </s-button>
              )}
            </s-stack>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Order")}</s-table-header>
              <s-table-header listSlot="secondary">{t("Customer")}</s-table-header>
              <s-table-header>{t("Product")}</s-table-header>
              <s-table-header>{t("Start date")}</s-table-header>
              <s-table-header>{t("Return by")}</s-table-header>
              <s-table-header>{t("Duration")}</s-table-header>
              <s-table-header format="currency">{t("Charged")}</s-table-header>
              <s-table-header listSlot="inline">{t("Status")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {bookings.map((b) => (
                <s-table-row key={b.id}>
                  <s-table-cell>
                    <Button variant="tertiary" onClick={() => navigate(`/app/bookings/${b.id}`)}>
                      {b.orderName || b.id.slice(-6).toUpperCase()}
                    </Button>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{b.customerName}</s-text>
                      <s-text color="subdued">{b.customerEmail}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{b.productTitle}</s-text>
                      {b.variantTitle && <s-text color="subdued">{b.variantTitle}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{format(new Date(b.startDate), "d MMM yyyy")}</s-table-cell>
                  <s-table-cell>{format(new Date(b.endDate), "d MMM yyyy")}</s-table-cell>
                  <s-table-cell>{`${b.rentalDays}d`}</s-table-cell>
                  <s-table-cell>{formatCurrency(b.totalCharged, currency)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={badgeTone(STATUS_BADGE[b.status]?.tone)}>
                      {t(STATUS_BADGE[b.status]?.label ?? "")}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
              <s-empty-state heading={t("No bookings match your filters")}>
                <s-text slot="subheading">{t("Try adjusting the filters or search term.")}</s-text>
              </s-empty-state>
            </s-table-body>
          </s-table>
        </s-section>
      </s-stack>
    </s-page>
  );
}
