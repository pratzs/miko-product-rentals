import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Banner,
  Text,
  Button,
  InlineStack,
  Thumbnail,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useState, useCallback } from "react";

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
    <Page
      title="Add Rental Product"
      subtitle="Choose a product from your store to enable for rental."
      backAction={{ content: "Rental Products", url: "/app/products" }}
    >
      <BlockStack gap="600">
        {actionData && "error" in actionData && (
          <Banner tone="critical" title={actionData.error} />
        )}

        <Card>
          <BlockStack gap="500">
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Select a product</Text>
              <Text as="p" tone="subdued">
                Pick any physical product you want to make available for rental.
                The product's existing Shopify listing stays unchanged - Miko Rentals
                adds a booking calendar to it automatically.
              </Text>
            </BlockStack>

            {!selectedProduct ? (
              <EmptyState
                heading="No product selected yet"
                action={{
                  content: picking ? "Opening picker…" : "Browse products",
                  onAction: openPicker,
                  loading: picking,
                }}
                image=""
              >
                <p>Click Browse products to pick from your Shopify catalogue.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="400">
                <InlineStack gap="400" blockAlign="center">
                  <Thumbnail
                    source={selectedProduct.image}
                    alt={selectedProduct.title}
                    size="large"
                  />
                  <BlockStack gap="100">
                    <Text as="p" variant="headingMd">{selectedProduct.title}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      ID: {selectedProduct.id}
                    </Text>
                  </BlockStack>
                </InlineStack>

                <InlineStack gap="300">
                  <Button variant="primary" onClick={confirmSelection}>
                    Add this product
                  </Button>
                  <Button variant="plain" onClick={() => setSelectedProduct(null)}>
                    Choose a different product
                  </Button>
                </InlineStack>
              </BlockStack>
            )}

            {!selectedProduct && (
              <InlineStack>
                <Button onClick={openPicker} loading={picking}>
                  Browse products
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
