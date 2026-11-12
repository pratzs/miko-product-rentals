import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { AppLink, Banner, flag } from "../components/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useState, useCallback } from "react";
import { useT } from "../i18n/context";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const shopifyProductId = formData.get("shopifyProductId") as string;
  const title = formData.get("title") as string;
  const image = formData.get("image") as string;

  if (!shopifyProductId) return json({ error: "No product selected." }, { status: 400 });

  const existing = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (existing) {
    return redirect(`/app/products/${existing.id}`);
  }

  const created = await db.rentalProduct.create({
    data: {
      shop,
      shopifyProductId,
      shopifyProductTitle: title,
      shopifyProductImage: image,
      totalUnits: 1,
      pricePerDay: 0,
      isActive: false,
    },
  });

  return redirect(`/app/products/${created.id}`);
};

export default function NewProductPage() {
  const t = useT();
  const navigate = useNavigate();
  const submit = useSubmit();
  const actionData = useActionData<typeof action>();
  const [selectedProduct, setSelectedProduct] = useState<{
    id: string;
    title: string;
    image: string;
  } | null>(null);
  const [picking, setPicking] = useState(false);

  const openPicker = useCallback(async () => {
    setPicking(true);
    // App Bridge ResourcePicker - dynamically imported so it only loads client-side.
    try {
      const shopify = (window as any).shopify;
      if (shopify?.resourcePicker) {
        const result = await shopify.resourcePicker({ type: "product", multiple: false });
        if (result && result[0]) {
          const p = result[0];
          setSelectedProduct({
            id: p.id,
            title: p.title,
            image: p.images?.[0]?.originalSrc || "",
          });
        }
      }
    } catch {
      // fallback: show a text input for the product GID
    } finally {
      setPicking(false);
    }
  }, []);

  function confirmSelection() {
    if (!selectedProduct) return;
    const fd = new FormData();
    fd.set("shopifyProductId", selectedProduct.id);
    fd.set("title", selectedProduct.title);
    fd.set("image", selectedProduct.image);
    submit(fd, { method: "POST" });
  }

  return (
    <s-page heading={t("Add Rental Product")} inlineSize="large">
      <AppLink slot="breadcrumb-actions" to="/app/products" navigate={navigate}>
        {t("Rental Products")}
      </AppLink>
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Choose a product from your store to enable for rental.")}</s-text>
        {actionData && "error" in actionData && (
          <Banner tone="critical" title={actionData.error} />
        )}

        <s-section>
          <s-stack direction="block" gap="large">
            <s-stack direction="block" gap="small-200">
              <s-heading>{t("Select a product")}</s-heading>
              <s-paragraph color="subdued">
                {t("Pick any physical product you want to make available for rental. The product's existing Shopify listing stays unchanged. Miko Rentals adds a booking calendar to it automatically.")}
              </s-paragraph>
            </s-stack>

            {!selectedProduct ? (
              <s-empty-state heading={t("No product selected yet")}>
                <s-text slot="subheading">{t("Click Browse products to pick from your Shopify catalog.")}</s-text>
                <s-button slot="primary-action" variant="primary" onClick={openPicker} loading={flag(picking)}>
                  {picking ? t("Opening picker…") : t("Browse products")}
                </s-button>
              </s-empty-state>
            ) : (
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-thumbnail src={selectedProduct.image || undefined} alt={selectedProduct.title} size="large" />
                  <s-stack direction="block" gap="small-300">
                    <s-heading>{selectedProduct.title}</s-heading>
                    <s-text color="subdued">{t("ID: {id}", { id: selectedProduct.id })}</s-text>
                  </s-stack>
                </s-stack>

                <s-stack direction="inline" gap="small">
                  <s-button variant="primary" onClick={confirmSelection}>
                    {t("Add this product")}
                  </s-button>
                  <s-button variant="tertiary" onClick={() => setSelectedProduct(null)}>
                    {t("Choose a different product")}
                  </s-button>
                </s-stack>
              </s-stack>
            )}

            {!selectedProduct && (
              <s-stack direction="inline">
                <s-button onClick={openPicker} loading={flag(picking)}>
                  {t("Browse products")}
                </s-button>
              </s-stack>
            )}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}
