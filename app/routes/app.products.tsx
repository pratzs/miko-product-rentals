import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useActionData, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  EmptyState,
  Thumbnail,
  Box,
  Divider,
  Banner,
  Spinner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useState } from "react";
import { formatCurrency } from "../utils/pricing";

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
    // Open the Shopify product picker — handled client-side via App Bridge.
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
    if (!isActive && product.pricePerDay === 0) {
      return json({ error: "Set a daily rental price before activating." }, { status: 400 });
    }

    await db.rentalProduct.update({
      where: { id: productId },
      data: { isActive },
    });

    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function ProductsPage() {
  const { rentalProducts, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [pickingProduct, setPickingProduct] = useState(false);

  async function openProductPicker() {
    setPickingProduct(true);
    try {
      const { ResourcePicker } = await import("@shopify/app-bridge-react");
    } catch {
      // fallback handled below
    }
    setPickingProduct(false);
  }

  function handleProductSelected(productId: string, title: string, image: string) {
    const fd = new FormData();
    fd.set("intent", "add_product");
    fd.set("shopifyProductId", productId);
    fd.set("title", title);
    fd.set("image", image);
    submit(fd, { method: "POST" });
  }

  function toggleActive(productId: string, currentlyActive: boolean) {
    const fd = new FormData();
    fd.set("intent", "toggle_active");
    fd.set("productId", productId);
    fd.set("isActive", (!currentlyActive).toString());
    submit(fd, { method: "POST" });
  }

  return (
    <Page
      title="Rental Products"
      subtitle="Choose which products in your store can be rented. Each product gets its own pricing, availability calendar, and deposit settings."
      primaryAction={{
        content: "Add rental product",
        onAction: () => navigate("/app/products/new"),
      }}
    >
      <BlockStack gap="600">
        {"error" in (actionData || {}) && (
          <Banner tone="critical" title={(actionData as any).error} />
        )}
        {"message" in (actionData || {}) && (
          <Banner tone="success" title={(actionData as any).message} />
        )}

        {rentalProducts.length === 0 ? (
          <Card>
            <EmptyState
              heading="No rental products yet"
              action={{
                content: "Add your first rental product",
                onAction: () => navigate("/app/products/new"),
              }}
              image=""
            >
              <p>
                Pick any product from your Shopify store and turn it into a rental.
                Customers will see a date picker on the product page and can book it
                directly without leaving your store.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Layout>
            {rentalProducts.map((product, i) => (
              <Layout.Section key={product.id} variant="oneHalf">
                <Card>
                  <BlockStack gap="400">
                    <InlineStack gap="400" blockAlign="start">
                      <Thumbnail
                        source={product.image || ""}
                        alt={product.title}
                        size="large"
                      />
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="start">
                          <Text as="h3" variant="headingMd">{product.title}</Text>
                          <Badge tone={product.isActive ? "success" : "attention"}>
                            {product.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {product.totalUnits} unit{product.totalUnits !== 1 ? "s" : ""} available
                        </Text>
                        {product.activeBookings > 0 && (
                          <Badge tone="info">
                            {product.activeBookings} active booking{product.activeBookings !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </BlockStack>
                    </InlineStack>

                    <Divider />

                    <InlineStack gap="400" wrap>
                      {product.pricePerDay > 0 && (
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" tone="subdued">Per day</Text>
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {formatCurrency(product.pricePerDay, currency)}
                          </Text>
                        </BlockStack>
                      )}
                      {product.pricePerWeek > 0 && (
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" tone="subdued">Per week</Text>
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {formatCurrency(product.pricePerWeek, currency)}
                          </Text>
                        </BlockStack>
                      )}
                      {product.pricePerMonth > 0 && (
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" tone="subdued">Per month</Text>
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {formatCurrency(product.pricePerMonth, currency)}
                          </Text>
                        </BlockStack>
                      )}
                      {product.depositAmount > 0 && (
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" tone="subdued">Deposit</Text>
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {formatCurrency(product.depositAmount, currency)}
                          </Text>
                        </BlockStack>
                      )}
                      {product.pricePerDay === 0 && (
                        <Badge tone="attention">Pricing not set</Badge>
                      )}
                    </InlineStack>

                    <InlineStack gap="300">
                      <Button onClick={() => navigate(`/app/products/${product.id}`)}>
                        Configure
                      </Button>
                      <Button
                        tone={product.isActive ? "critical" : undefined}
                        variant="plain"
                        onClick={() => toggleActive(product.id, product.isActive)}
                        disabled={!product.isActive && product.pricePerDay === 0}
                      >
                        {product.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </Layout.Section>
            ))}
          </Layout>
        )}
      </BlockStack>
    </Page>
  );
}
