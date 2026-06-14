import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigate, Form, useActionData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Badge,
  Thumbnail,
  Select,
  Checkbox,
  Divider,
  Box,
  Tooltip,
  Icon,
} from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useState } from "react";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { id } = params;

  const [config, product] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalProduct.findFirst({
      where: { id, shop },
      include: {
        _count: { select: { bookings: true } },
        bookings: {
          where: { status: { in: ["confirmed", "active"] } },
          select: { id: true },
        },
      },
    }),
  ]);

  if (!product) throw new Response("Not found", { status: 404 });

  return json({
    currency: config?.currency || "USD",
    product: {
      id: product.id,
      shopifyProductId: product.shopifyProductId,
      title: product.shopifyProductTitle,
      image: product.shopifyProductImage,
      totalUnits: product.totalUnits,
      pricePerDay: product.pricePerDay,
      pricePerWeek: product.pricePerWeek,
      pricePerMonth: product.pricePerMonth,
      depositAmount: product.depositAmount,
      autoReleaseDeposit: product.autoReleaseDeposit,
      minRentalDays: product.minRentalDays,
      maxRentalDays: product.maxRentalDays,
      rentalNotes: product.rentalNotes,
      isActive: product.isActive,
      totalBookings: product._count.bookings,
      activeBookings: product.bookings.length,
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { id } = params;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const product = await db.rentalProduct.findFirst({ where: { id, shop } });
  if (!product) return json({ error: "Product not found." }, { status: 404 });

  if (intent === "save") {
    const pricePerDay = parseFloat(formData.get("pricePerDay") as string) || 0;
    const pricePerWeek = parseFloat(formData.get("pricePerWeek") as string) || 0;
    const pricePerMonth = parseFloat(formData.get("pricePerMonth") as string) || 0;
    const depositAmount = parseFloat(formData.get("depositAmount") as string) || 0;
    const totalUnits = parseInt(formData.get("totalUnits") as string) || 1;
    const minRentalDays = parseInt(formData.get("minRentalDays") as string) || 1;
    const maxRentalDays = parseInt(formData.get("maxRentalDays") as string) || 0;
    const autoReleaseDeposit = formData.get("autoReleaseDeposit") === "true";
    const rentalNotes = (formData.get("rentalNotes") as string) || "";

    if (pricePerDay <= 0) {
      return json({ error: "Daily price is required. Weekly and monthly prices are optional." }, { status: 400 });
    }
    if (totalUnits < 1) {
      return json({ error: "You must have at least 1 unit available." }, { status: 400 });
    }

    await db.rentalProduct.update({
      where: { id },
      data: {
        pricePerDay,
        pricePerWeek,
        pricePerMonth,
        depositAmount,
        totalUnits,
        minRentalDays,
        maxRentalDays,
        autoReleaseDeposit,
        rentalNotes,
      },
    });

    return json({ success: true, message: "Settings saved successfully." });
  }

  if (intent === "toggle_active") {
    if (!product.isActive && product.pricePerDay === 0) {
      return json({ error: "Set a daily price before activating this product." }, { status: 400 });
    }
    await db.rentalProduct.update({
      where: { id },
      data: { isActive: !product.isActive },
    });
    return json({ success: true, message: product.isActive ? "Product deactivated." : "Product is now live for rentals." });
  }

  if (intent === "delete") {
    if (product.isActive) {
      return json({ error: "Deactivate the product before deleting it." }, { status: 400 });
    }
    await db.rentalProduct.delete({ where: { id } });
    return redirect("/app/products");
  }

  return json({ error: "Unknown action." }, { status: 400 });
};

export default function ProductConfigPage() {
  const { product, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const saving = navigation.state === "submitting";

  const [pricePerDay, setPricePerDay] = useState(product.pricePerDay.toString());
  const [pricePerWeek, setPricePerWeek] = useState(product.pricePerWeek.toString());
  const [pricePerMonth, setPricePerMonth] = useState(product.pricePerMonth.toString());
  const [depositAmount, setDepositAmount] = useState(product.depositAmount.toString());
  const [totalUnits, setTotalUnits] = useState(product.totalUnits.toString());
  const [minRentalDays, setMinRentalDays] = useState(product.minRentalDays.toString());
  const [maxRentalDays, setMaxRentalDays] = useState(product.maxRentalDays.toString());
  const [autoReleaseDeposit, setAutoReleaseDeposit] = useState(product.autoReleaseDeposit);
  const [rentalNotes, setRentalNotes] = useState(product.rentalNotes);

  return (
    <Page
      title={product.title}
      subtitle="Configure how this product is rented"
      backAction={{ content: "Rental Products", url: "/app/products" }}
      primaryAction={
        <Form method="POST">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="pricePerDay" value={pricePerDay} />
          <input type="hidden" name="pricePerWeek" value={pricePerWeek} />
          <input type="hidden" name="pricePerMonth" value={pricePerMonth} />
          <input type="hidden" name="depositAmount" value={depositAmount} />
          <input type="hidden" name="totalUnits" value={totalUnits} />
          <input type="hidden" name="minRentalDays" value={minRentalDays} />
          <input type="hidden" name="maxRentalDays" value={maxRentalDays} />
          <input type="hidden" name="autoReleaseDeposit" value={autoReleaseDeposit.toString()} />
          <input type="hidden" name="rentalNotes" value={rentalNotes} />
          <Button variant="primary" submit loading={saving}>Save settings</Button>
        </Form>
      }
      secondaryActions={[
        {
          content: product.isActive ? "Deactivate" : "Activate",
          onAction: () => {
            const fd = new FormData();
            fd.set("intent", "toggle_active");
            fetch("", { method: "POST", body: fd });
          },
          destructive: product.isActive,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="600">
            {actionData && "error" in actionData && (
              <Banner tone="critical" title={actionData.error} />
            )}
            {actionData && "message" in actionData && (
              <Banner tone="success" title={(actionData as any).message} />
            )}

            {/* Product summary */}
            <Card>
              <InlineStack gap="400" blockAlign="center">
                <Thumbnail source={product.image} alt={product.title} size="large" />
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingLg">{product.title}</Text>
                    <Badge tone={product.isActive ? "success" : "attention"}>
                      {product.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {product.totalBookings} total booking{product.totalBookings !== 1 ? "s" : ""} &bull;{" "}
                    {product.activeBookings} currently active
                  </Text>
                </BlockStack>
              </InlineStack>
            </Card>

            {/* Pricing */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Rental pricing</Text>
                  <Text as="p" tone="subdued">
                    Set how much customers pay to rent this item. Daily rate is required.
                    Weekly and monthly rates are optional — when offered, customers automatically
                    get the best rate for their chosen dates.
                  </Text>
                </BlockStack>
                <Divider />
                <InlineStack gap="400" wrap>
                  <Box minWidth="180px">
                    <TextField
                      label="Price per day"
                      type="number"
                      value={pricePerDay}
                      onChange={setPricePerDay}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      helpText="Required"
                    />
                  </Box>
                  <Box minWidth="180px">
                    <TextField
                      label="Price per week"
                      type="number"
                      value={pricePerWeek}
                      onChange={setPricePerWeek}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      helpText="Optional — leave at 0 to not offer"
                    />
                  </Box>
                  <Box minWidth="180px">
                    <TextField
                      label="Price per month"
                      type="number"
                      value={pricePerMonth}
                      onChange={setPricePerMonth}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      helpText="Optional — leave at 0 to not offer"
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Deposit */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Security deposit</Text>
                  <Text as="p" tone="subdued">
                    A deposit is an extra amount collected at checkout that is held until
                    the item is returned in good condition. Leave at 0 if you do not want
                    to collect a deposit.
                  </Text>
                </BlockStack>
                <Divider />
                <Box maxWidth="220px">
                  <TextField
                    label="Deposit amount"
                    type="number"
                    value={depositAmount}
                    onChange={setDepositAmount}
                    prefix={currency}
                    min={0}
                    step={0.01}
                    autoComplete="off"
                    helpText="0 = no deposit"
                  />
                </Box>
                <Checkbox
                  label="Automatically mark deposit as released when the booking is marked as returned"
                  checked={autoReleaseDeposit}
                  onChange={setAutoReleaseDeposit}
                  helpText="You will still need to process the actual refund through Shopify separately."
                />
              </BlockStack>
            </Card>

            {/* Inventory & Duration */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Inventory and duration</Text>
                  <Text as="p" tone="subdued">
                    How many physical units do you have available to rent out at the same time?
                    You can also set minimum and maximum rental lengths.
                  </Text>
                </BlockStack>
                <Divider />
                <InlineStack gap="400" wrap>
                  <Box minWidth="160px">
                    <TextField
                      label="Units available"
                      type="number"
                      value={totalUnits}
                      onChange={setTotalUnits}
                      min={1}
                      autoComplete="off"
                      helpText="How many can be out at the same time"
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Minimum rental days"
                      type="number"
                      value={minRentalDays}
                      onChange={setMinRentalDays}
                      min={1}
                      autoComplete="off"
                      helpText="Shortest booking allowed"
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Maximum rental days"
                      type="number"
                      value={maxRentalDays}
                      onChange={setMaxRentalDays}
                      min={0}
                      autoComplete="off"
                      helpText="0 = no maximum"
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Notes */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Customer-facing notes</Text>
                  <Text as="p" tone="subdued">
                    Any extra instructions shown to the customer on the product page — for example,
                    pickup location, what is included, or care instructions.
                  </Text>
                </BlockStack>
                <Divider />
                <TextField
                  label="Rental notes"
                  value={rentalNotes}
                  onChange={setRentalNotes}
                  multiline={4}
                  autoComplete="off"
                  placeholder="e.g. Collect from our store at 123 Main Street between 9am–5pm. Helmet and lock included."
                />
              </BlockStack>
            </Card>

            {/* Danger zone */}
            {!product.isActive && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd" tone="critical">Remove product</Text>
                  <Text as="p" tone="subdued">
                    This removes the rental configuration from this product. The product itself
                    stays in your Shopify store — only the rental settings are deleted.
                    You cannot do this while the product is active.
                  </Text>
                  <Form method="POST">
                    <input type="hidden" name="intent" value="delete" />
                    <Button tone="critical" submit>Remove rental product</Button>
                  </Form>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">How it works</Text>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="start">
                    <Text as="span" variant="bodyMd" fontWeight="bold">1.</Text>
                    <Text as="p" tone="subdued">Customer picks their rental dates on your product page</Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start">
                    <Text as="span" variant="bodyMd" fontWeight="bold">2.</Text>
                    <Text as="p" tone="subdued">Price and deposit are calculated automatically</Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start">
                    <Text as="span" variant="bodyMd" fontWeight="bold">3.</Text>
                    <Text as="p" tone="subdued">Customer pays through your normal Shopify checkout</Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start">
                    <Text as="span" variant="bodyMd" fontWeight="bold">4.</Text>
                    <Text as="p" tone="subdued">Booking appears here so you can manage pickup, returns, and deposits</Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Quick actions</Text>
                <Button
                  fullWidth
                  onClick={() => navigate(`/app/bookings?productId=${product.id}`)}
                >
                  View bookings for this product
                </Button>
                <Button
                  fullWidth
                  onClick={() => navigate(`/app/calendar?productId=${product.id}`)}
                >
                  View availability calendar
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
