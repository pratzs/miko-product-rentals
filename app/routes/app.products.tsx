import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useActionData, Form } from "@remix-run/react";
import { Banner, Grid, flag } from "../components/polaris";
import { TWO_UP } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { formatCurrency } from "../utils/pricing";
import { setRentalMetafield, ensureRentalVariantsCanOversell } from "../utils/product-metafields.server";
import { syncRentalProductConfig } from "../utils/rental-config-metafields.server";
import { syncRentalProductVariants } from "../utils/variant-sync.server";
import { useT } from "../i18n/context";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, rentalProducts] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalProduct.findMany({
      where: { shop },
      include: {
        _count: {
          select: {
            bookings: { where: { status: { in: ["confirmed", "active"] } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return json({
    currency: config?.currency || "USD",
    rentalProducts: rentalProducts.map((p) => ({
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      title: p.shopifyProductTitle,
      image: p.shopifyProductImage,
      totalUnits: p.totalUnits,
      pricePerDay: p.pricePerDay,
      pricePerWeek: p.pricePerWeek,
      pricePerMonth: p.pricePerMonth,
      depositAmount: p.depositAmount,
      isActive: p.isActive,
      activeBookings: p._count.bookings,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "add_product") {
    // Open the Shopify product picker - handled client-side via App Bridge.
    // The client POSTs the selected product details back here.
    const shopifyProductId = formData.get("shopifyProductId") as string;
    const title = formData.get("title") as string;
    const image = formData.get("image") as string;

    if (!shopifyProductId) return json({ error: "No product selected" }, { status: 400 });

    await db.rentalProduct.upsert({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      create: {
        shop,
        shopifyProductId,
        shopifyProductTitle: title,
        shopifyProductImage: image,
        totalUnits: 1,
        pricePerDay: 0,
        isActive: false, // merchant must configure before activating
      },
      update: {
        shopifyProductTitle: title,
        shopifyProductImage: image,
      },
    });

    return json({ success: true, message: "Product added. Now configure its rental settings." });
  }

  if (intent === "toggle_active") {
    const productId = formData.get("productId") as string;
    const isActive = formData.get("isActive") === "true";

    const product = await db.rentalProduct.findFirst({
      where: { id: productId, shop },
    });
    if (!product) return json({ error: "Product not found" }, { status: 404 });
    if (isActive && product.pricePerDay === 0 && product.depositAmount === 0) {
      return json({ error: "Set a daily rental price, or a refundable deposit for free rentals, before activating." }, { status: 400 });
    }

    await db.rentalProduct.update({
      where: { id: productId },
      data: { isActive },
    });

    // Sync the storefront-visible metafield so the App Embed Block can
    // detect rental products and hide their regular price / Add to cart.
    await setRentalMetafield(admin, product.shopifyProductId, isActive);

    // When activating, ensure customers can always book regardless of stock.
    if (isActive) {
      await ensureRentalVariantsCanOversell(admin, product.shopifyProductId);
    }

    // Checkout prices rentals from these metafields (and stops when inactive).
    await syncRentalProductConfig(admin, product.id);

    return json({ success: true });
  }

  if (intent === "backfill_metafields") {
    // One-shot fix: re-sync the miko.is_rental metafield for every product so
    // the new App Embed Block can detect rentals immediately, without needing
    // the merchant to toggle each one off and on.
    const allProducts = await db.rentalProduct.findMany({ where: { shop } });
    for (const p of allProducts) {
      await setRentalMetafield(admin, p.shopifyProductId, p.isActive);
      if (p.isActive) {
        await ensureRentalVariantsCanOversell(admin, p.shopifyProductId);
        // Pull variants too so multi-variant products that were activated
        // before the variant feature existed get their RentalVariant rows.
        await syncRentalProductVariants(admin, p.id);
      }
      await syncRentalProductConfig(admin, p.id);
    }
    return json({
      success: true,
      message: `Synced ${allProducts.length} product${allProducts.length === 1 ? "" : "s"} with the storefront.`,
    });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function ProductsPage() {
  const t = useT();
  const { rentalProducts, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const submit = useSubmit();
  function toggleActive(productId: string, currentlyActive: boolean) {
    const fd = new FormData();
    fd.set("intent", "toggle_active");
    fd.set("productId", productId);
    fd.set("isActive", (!currentlyActive).toString());
    submit(fd, { method: "POST" });
  }

  function syncStorefront() {
    const fd = new FormData();
    fd.set("intent", "backfill_metafields");
    submit(fd, { method: "POST" });
  }

  return (
    <s-page heading={t("Rental Products")} inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/products/new")}>
        {t("Add rental product")}
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={syncStorefront}
        accessibilityLabel={t("Re-sync the rental flag on every product so the storefront embed knows which products are rentals.")}
      >
        {t("Sync with storefront")}
      </s-button>
      <s-stack direction="block" gap="large">
        <s-text color="subdued">
          {t("Choose which products in your store can be rented. Each product gets its own pricing, availability calendar, and deposit settings.")}
        </s-text>
        {"error" in (actionData || {}) && (
          <Banner tone="critical" title={(actionData as any).error} />
        )}
        {"message" in (actionData || {}) && (
          <Banner tone="success" title={(actionData as any).message} />
        )}

        {rentalProducts.length === 0 ? (
          <s-section>
            <s-empty-state heading={t("No rental products yet")}>
              <s-text slot="subheading">
                {t("Pick any product from your Shopify store and turn it into a rental. Customers will see a date picker on the product page and can book it directly without leaving your store.")}
              </s-text>
              <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/products/new")}>
                {t("Add your first rental product")}
              </s-button>
            </s-empty-state>
          </s-section>
        ) : (
          <Grid columns={TWO_UP} gap="base">
            {rentalProducts.map((product) => (
              <s-section key={product.id}>
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base" alignItems="start">
                    <s-thumbnail src={product.image || undefined} alt={product.title} size="large" />
                    <s-stack direction="block" gap="small-200">
                      <s-stack direction="inline" gap="small-200" justifyContent="space-between" alignItems="start">
                        <s-heading>{product.title}</s-heading>
                        <s-badge tone={product.isActive ? "success" : "caution"}>
                          {product.isActive ? t("Active") : t("Inactive")}
                        </s-badge>
                      </s-stack>
                      <s-text color="subdued">
                        {product.totalUnits === 1
                          ? t("{n} unit available", { n: product.totalUnits })
                          : t("{n} units available", { n: product.totalUnits })}
                      </s-text>
                      {product.activeBookings > 0 && (
                        <s-badge tone="info">
                          {product.activeBookings === 1
                            ? t("{n} active booking", { n: product.activeBookings })
                            : t("{n} active bookings", { n: product.activeBookings })}
                        </s-badge>
                      )}
                    </s-stack>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="inline" gap="base">
                    {product.pricePerDay > 0 && (
                      <s-stack direction="block" gap="none">
                        <s-text color="subdued">{t("Per day")}</s-text>
                        <s-text fontWeight="medium">{formatCurrency(product.pricePerDay, currency)}</s-text>
                      </s-stack>
                    )}
                    {product.pricePerWeek > 0 && (
                      <s-stack direction="block" gap="none">
                        <s-text color="subdued">{t("Per week")}</s-text>
                        <s-text fontWeight="medium">{formatCurrency(product.pricePerWeek, currency)}</s-text>
                      </s-stack>
                    )}
                    {product.pricePerMonth > 0 && (
                      <s-stack direction="block" gap="none">
                        <s-text color="subdued">{t("Per month")}</s-text>
                        <s-text fontWeight="medium">{formatCurrency(product.pricePerMonth, currency)}</s-text>
                      </s-stack>
                    )}
                    {product.depositAmount > 0 && (
                      <s-stack direction="block" gap="none">
                        <s-text color="subdued">{t("Deposit")}</s-text>
                        <s-text fontWeight="medium">{formatCurrency(product.depositAmount, currency)}</s-text>
                      </s-stack>
                    )}
                    {product.pricePerDay === 0 && product.depositAmount === 0 && (
                      <s-badge tone="caution">{t("Pricing not set")}</s-badge>
                    )}
                    {product.pricePerDay === 0 && product.depositAmount > 0 && (
                      <s-badge tone="info">{t("Free rental")}</s-badge>
                    )}
                  </s-stack>

                  <s-stack direction="inline" gap="small">
                    <s-button onClick={() => navigate(`/app/products/${product.id}`)}>
                      {t("Configure")}
                    </s-button>
                    <s-button
                      tone={product.isActive ? "critical" : undefined}
                      variant="tertiary"
                      onClick={() => toggleActive(product.id, product.isActive)}
                      disabled={flag(!product.isActive && product.pricePerDay === 0 && product.depositAmount === 0)}
                    >
                      {product.isActive ? t("Deactivate") : t("Activate")}
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-section>
            ))}
          </Grid>
        )}
      </s-stack>
    </s-page>
  );
}
