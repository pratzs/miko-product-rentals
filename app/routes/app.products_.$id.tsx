import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigate, Form, useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { AppLink, Banner, Checkbox, Grid, TextField, flag, useCustomEvent } from "../components/polaris";
import { MAIN_WITH_SIDEBAR } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { setRentalMetafield, ensureRentalVariantsCanOversell } from "../utils/product-metafields.server";
import { syncRentalProductConfig, clearRentalProductConfig } from "../utils/rental-config-metafields.server";
import { syncRentalProductVariants } from "../utils/variant-sync.server";
import { useRef, useState } from "react";
import { useT } from "../i18n/context";

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
        variants: {
          orderBy: { shopifyVariantTitle: "asc" },
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
      allowRentalWhenSoldOut: product.allowRentalWhenSoldOut,
      minRentalDays: product.minRentalDays,
      maxRentalDays: product.maxRentalDays,
      rentalNotes: product.rentalNotes,
      isActive: product.isActive,
      hasVariants: product.hasVariants,
      totalBookings: product._count.bookings,
      activeBookings: product.bookings.length,
      variants: product.variants.map((v) => ({
        id: v.id,
        shopifyVariantId: v.shopifyVariantId,
        title: v.shopifyVariantTitle,
        totalUnits: v.totalUnits,
        pricePerDay: v.pricePerDay,
        pricePerWeek: v.pricePerWeek,
        pricePerMonth: v.pricePerMonth,
        depositAmount: v.depositAmount,
        isActive: v.isActive,
      })),
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
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
    const allowRentalWhenSoldOut = formData.get("allowRentalWhenSoldOut") !== "false";
    const rentalNotes = (formData.get("rentalNotes") as string) || "";

    if (pricePerDay <= 0 && depositAmount <= 0) {
      return json({ error: "Set a daily price, or a refundable deposit for free rentals." }, { status: 400 });
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
        allowRentalWhenSoldOut,
        rentalNotes,
      },
    });

    // When the merchant disables the override, we don't need to do anything
    // special — the product stays purchasable until Shopify's own inventory
    // enforcement kicks in on the next cart add.
    // When re-enabling, run the override immediately so the merchant doesn't
    // have to also click "Sync with storefront".
    if (allowRentalWhenSoldOut) {
      await ensureRentalVariantsCanOversell(admin, product.shopifyProductId);
    }

    // Checkout prices rentals from these metafields, so new rates must reach
    // Shopify with every save.
    await syncRentalProductConfig(admin, product.id);

    return json({ success: true, message: "Settings saved successfully." });
  }

  if (intent === "toggle_active") {
    if (!product.isActive && product.pricePerDay === 0 && product.depositAmount === 0) {
      return json({ error: "Set a daily price, or a refundable deposit for free rentals, before activating this product." }, { status: 400 });
    }
    const newActive = !product.isActive;
    await db.rentalProduct.update({
      where: { id },
      data: { isActive: newActive },
    });
    await setRentalMetafield(admin, product.shopifyProductId, newActive);
    if (newActive) {
      await ensureRentalVariantsCanOversell(admin, product.shopifyProductId);
      // Pull the latest variant list whenever a rental goes live so multi
      // variant products get their per-variant rows created automatically.
      await syncRentalProductVariants(admin, product.id);
    }
    await syncRentalProductConfig(admin, product.id);
    return json({ success: true, message: product.isActive ? "Product deactivated." : "Product is now live for rentals." });
  }

  if (intent === "sync_variants") {
    const result = await syncRentalProductVariants(admin, product.id);
    // Also re-flip inventory policy on every variant so any newly added
    // variants in Shopify can be added to cart even when their stock is 0.
    await ensureRentalVariantsCanOversell(admin, product.shopifyProductId);
    await syncRentalProductConfig(admin, product.id);
    return json({
      success: true,
      message: result.hasVariants
        ? `Synced ${result.variants.length} variant${result.variants.length === 1 ? "" : "s"} from Shopify.`
        : "This product has no variants in Shopify. It will be treated as a single rental.",
    });
  }

  if (intent === "save_variant") {
    const variantId = formData.get("variantId") as string;
    const variant = await db.rentalVariant.findFirst({
      where: { id: variantId, rentalProductId: product.id },
    });
    if (!variant) {
      return json({ error: "Variant not found." }, { status: 404 });
    }
    const pricePerDay = parseFloat(formData.get("pricePerDay") as string) || 0;
    const pricePerWeek = parseFloat(formData.get("pricePerWeek") as string) || 0;
    const pricePerMonth = parseFloat(formData.get("pricePerMonth") as string) || 0;
    const depositAmount = parseFloat(formData.get("depositAmount") as string) || 0;
    const totalUnits = parseInt(formData.get("totalUnits") as string) || 1;
    const isActive = formData.get("isActive") === "true";
    if (isActive && pricePerDay <= 0 && depositAmount <= 0) {
      return json({ error: "Set a daily price, or a refundable deposit for free rentals, before activating this variant." }, { status: 400 });
    }
    await db.rentalVariant.update({
      where: { id: variant.id },
      data: { pricePerDay, pricePerWeek, pricePerMonth, depositAmount, totalUnits, isActive },
    });
    await syncRentalProductConfig(admin, product.id);
    return json({ success: true, message: `Variant "${variant.shopifyVariantTitle}" saved.` });
  }

  if (intent === "delete") {
    if (product.isActive) {
      return json({ error: "Deactivate the product before deleting it." }, { status: 400 });
    }
    await db.rentalProduct.delete({ where: { id } });
    // Switch rental pricing off at checkout for this product.
    await clearRentalProductConfig(admin, product.shopifyProductId);
    return redirect("/app/products");
  }

  return json({ error: "Unknown action." }, { status: 400 });
};

export default function ProductConfigPage() {
  const t = useT();
  const { product, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const submit = useSubmit();
  const saving = navigation.state === "submitting";
  // The save form lives in the page body (s-page's primary-action slot takes
  // a single button, not a form); the header button submits it.
  const saveFormRef = useRef<HTMLFormElement>(null);

  const [pricePerDay, setPricePerDay] = useState(product.pricePerDay.toString());
  const [pricePerWeek, setPricePerWeek] = useState(product.pricePerWeek.toString());
  const [pricePerMonth, setPricePerMonth] = useState(product.pricePerMonth.toString());
  const [depositAmount, setDepositAmount] = useState(product.depositAmount.toString());
  const [totalUnits, setTotalUnits] = useState(product.totalUnits.toString());
  const [minRentalDays, setMinRentalDays] = useState(product.minRentalDays.toString());
  const [maxRentalDays, setMaxRentalDays] = useState(product.maxRentalDays.toString());
  const [autoReleaseDeposit, setAutoReleaseDeposit] = useState(product.autoReleaseDeposit);
  const [allowRentalWhenSoldOut, setAllowRentalWhenSoldOut] = useState(product.allowRentalWhenSoldOut);
  const [rentalNotes, setRentalNotes] = useState(product.rentalNotes);

  return (
    <s-page heading={product.title} inlineSize="large">
      <AppLink slot="breadcrumb-actions" to="/app/products" navigate={navigate}>
        {t("Rental Products")}
      </AppLink>
      <s-button
        slot="primary-action"
        variant="primary"
        loading={flag(saving)}
        onClick={() => saveFormRef.current?.requestSubmit()}
      >
        {t("Save settings")}
      </s-button>
      <s-button
        slot="secondary-actions"
        tone={product.isActive ? "critical" : undefined}
        onClick={() => {
          const fd = new FormData();
          fd.set("intent", "toggle_active");
          submit(fd, { method: "POST" });
        }}
      >
        {product.isActive ? t("Deactivate") : t("Activate")}
      </s-button>

      {/* Same fields, names and values the header Form used to post. */}
      <Form method="POST" ref={saveFormRef} style={{ display: "none" }}>
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="pricePerDay" value={pricePerDay} />
        <input type="hidden" name="pricePerWeek" value={pricePerWeek} />
        <input type="hidden" name="pricePerMonth" value={pricePerMonth} />
        <input type="hidden" name="depositAmount" value={depositAmount} />
        <input type="hidden" name="totalUnits" value={totalUnits} />
        <input type="hidden" name="minRentalDays" value={minRentalDays} />
        <input type="hidden" name="maxRentalDays" value={maxRentalDays} />
        <input type="hidden" name="autoReleaseDeposit" value={autoReleaseDeposit.toString()} />
        <input type="hidden" name="allowRentalWhenSoldOut" value={allowRentalWhenSoldOut.toString()} />
        <input type="hidden" name="rentalNotes" value={rentalNotes} />
      </Form>

      <s-stack direction="block" gap="base">
        <s-text color="subdued">{t("Configure how this product is rented")}</s-text>
        <Grid columns={MAIN_WITH_SIDEBAR} gap="base">
          <s-stack direction="block" gap="large">
            {actionData && "error" in actionData && (
              <Banner tone="critical" title={actionData.error} />
            )}
            {actionData && "message" in actionData && (
              <Banner tone="success" title={(actionData as any).message} />
            )}

            {/* Product summary */}
            <s-section>
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-thumbnail src={product.image || undefined} alt={product.title} size="large" />
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-heading>{product.title}</s-heading>
                    <s-badge tone={product.isActive ? "success" : "caution"}>
                      {product.isActive ? t("Active") : t("Inactive")}
                    </s-badge>
                  </s-stack>
                  <s-text color="subdued">
                    {product.totalBookings === 1
                      ? t("{total} total booking • {active} currently active", {
                          total: product.totalBookings,
                          active: product.activeBookings,
                        })
                      : t("{total} total bookings • {active} currently active", {
                          total: product.totalBookings,
                          active: product.activeBookings,
                        })}
                  </s-text>
                </s-stack>
              </s-stack>
            </s-section>

            {/* Pricing */}
            <s-section heading={t("Rental pricing")}>
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  {t("Set how much customers pay to rent this item. Daily rate is required. Weekly and monthly rates are optional - when offered, customers automatically get the best rate for their chosen dates.")}
                </s-paragraph>
                <s-divider />
                <s-stack direction="inline" gap="base">
                  <s-box minInlineSize="180px">
                    <TextField
                      label={t("Price per day")}
                      type="number"
                      value={pricePerDay}
                      onChange={setPricePerDay}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      details={t("Required")}
                    />
                  </s-box>
                  <s-box minInlineSize="180px">
                    <TextField
                      label={t("Price per week")}
                      type="number"
                      value={pricePerWeek}
                      onChange={setPricePerWeek}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      details={t("Optional. Leave at 0 to skip this rate.")}
                    />
                  </s-box>
                  <s-box minInlineSize="180px">
                    <TextField
                      label={t("Price per month")}
                      type="number"
                      value={pricePerMonth}
                      onChange={setPricePerMonth}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      details={t("Optional. Leave at 0 to skip this rate.")}
                    />
                  </s-box>
                </s-stack>
              </s-stack>
            </s-section>

            {/* Deposit */}
            <s-section heading={t("Security deposit")}>
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  {t("A deposit is an extra amount collected at checkout that is held until the item is returned in good condition. Leave at 0 if you do not want to collect a deposit.")}
                </s-paragraph>
                <s-divider />
                <s-box maxInlineSize="220px">
                  <TextField
                    label={t("Deposit amount")}
                    type="number"
                    value={depositAmount}
                    onChange={setDepositAmount}
                    prefix={currency}
                    min={0}
                    step={0.01}
                    autoComplete="off"
                    details={t("0 = no deposit")}
                  />
                </s-box>
                <Checkbox
                  label={t("Automatically mark deposit as released when the booking is marked as returned")}
                  checked={autoReleaseDeposit}
                  onChange={setAutoReleaseDeposit}
                  details={t("You will still need to process the actual refund through Shopify separately.")}
                />
                <s-divider />
                <Checkbox
                  label={t("Allow rental even when Shopify shows product as sold out")}
                  checked={allowRentalWhenSoldOut}
                  onChange={setAllowRentalWhenSoldOut}
                  details={t("When on (recommended), the app overrides Shopify's inventory so customers can always add a rental to cart. Miko's calendar is the availability source of truth. Turn off only if you also want Shopify stock to gate rentals.")}
                />
              </s-stack>
            </s-section>

            {/* Inventory & Duration */}
            <s-section heading={t("Inventory and duration")}>
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  {t("How many physical units do you have available to rent out at the same time? You can also set minimum and maximum rental lengths.")}
                </s-paragraph>
                <s-divider />
                <s-stack direction="inline" gap="base">
                  <s-box minInlineSize="160px">
                    <TextField
                      label={t("Units available")}
                      type="number"
                      value={totalUnits}
                      onChange={setTotalUnits}
                      min={1}
                      autoComplete="off"
                      details={t("How many can be out at the same time")}
                    />
                  </s-box>
                  <s-box minInlineSize="160px">
                    <TextField
                      label={t("Minimum rental days")}
                      type="number"
                      value={minRentalDays}
                      onChange={setMinRentalDays}
                      min={1}
                      autoComplete="off"
                      details={t("Shortest booking allowed")}
                    />
                  </s-box>
                  <s-box minInlineSize="160px">
                    <TextField
                      label={t("Maximum rental days")}
                      type="number"
                      value={maxRentalDays}
                      onChange={setMaxRentalDays}
                      min={0}
                      autoComplete="off"
                      details={t("0 = no maximum")}
                    />
                  </s-box>
                </s-stack>
              </s-stack>
            </s-section>

            {/* Notes */}
            <s-section heading={t("Customer-facing notes")}>
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  {t("Any extra instructions shown to the customer on the product page - for example, pickup location, what is included, or care instructions.")}
                </s-paragraph>
                <s-divider />
                <TextField
                  label={t("Rental notes")}
                  value={rentalNotes}
                  onChange={setRentalNotes}
                  multiline={4}
                  autoComplete="off"
                  placeholder={t("e.g. Collect from our store at 123 Main Street between 9am-5pm. Helmet and lock included.")}
                />
              </s-stack>
            </s-section>

            {/* Variants */}
            <VariantsCard
              productId={product.id}
              hasVariants={product.hasVariants}
              variants={product.variants}
              currency={currency}
            />

            {/* Danger zone */}
            {!product.isActive && (
              <s-section>
                <s-stack direction="block" gap="base">
                  <s-heading>
                    <s-text tone="critical">{t("Remove product")}</s-text>
                  </s-heading>
                  <s-paragraph color="subdued">
                    {t("This removes the rental configuration from this product. The product itself stays in your Shopify store - only the rental settings are deleted. You cannot do this while the product is active.")}
                  </s-paragraph>
                  <Form method="POST">
                    <input type="hidden" name="intent" value="delete" />
                    <s-button tone="critical" type="submit">{t("Remove rental product")}</s-button>
                  </Form>
                </s-stack>
              </s-section>
            )}
          </s-stack>

          {/* Sidebar */}
          <s-stack direction="block" gap="base">
            <s-section heading={t("How it works")}>
              <s-ordered-list>
                <s-list-item>
                  <s-text color="subdued">{t("Customer picks their rental dates on your product page")}</s-text>
                </s-list-item>
                <s-list-item>
                  <s-text color="subdued">{t("Price and deposit are calculated automatically")}</s-text>
                </s-list-item>
                <s-list-item>
                  <s-text color="subdued">{t("Customer pays through your normal Shopify checkout")}</s-text>
                </s-list-item>
                <s-list-item>
                  <s-text color="subdued">{t("Booking appears here so you can manage pickup, returns, and deposits")}</s-text>
                </s-list-item>
              </s-ordered-list>
            </s-section>

            <s-section heading={t("Quick actions")}>
              <s-stack direction="block" gap="small">
                <s-button
                  inlineSize="fill"
                  onClick={() => navigate(`/app/bookings?productId=${product.id}`)}
                >
                  {t("View bookings for this product")}
                </s-button>
                <s-button
                  inlineSize="fill"
                  onClick={() => navigate(`/app/calendar?productId=${product.id}`)}
                >
                  {t("View availability calendar")}
                </s-button>
              </s-stack>
            </s-section>
          </s-stack>
        </Grid>
      </s-stack>
    </s-page>
  );
}

interface VariantRow {
  id: string;
  shopifyVariantId: string;
  title: string;
  totalUnits: number;
  pricePerDay: number;
  pricePerWeek: number;
  pricePerMonth: number;
  depositAmount: number;
  isActive: boolean;
}

function VariantsCard({
  productId,
  hasVariants,
  variants,
  currency,
}: {
  productId: string;
  hasVariants: boolean;
  variants: VariantRow[];
  currency: string;
}) {
  const t = useT();
  const submit = useSubmit();
  const navigation = useNavigation();
  const syncing = navigation.formData?.get("intent") === "sync_variants";

  function onSync() {
    const fd = new FormData();
    fd.set("intent", "sync_variants");
    submit(fd, { method: "POST" });
  }

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
          <s-stack direction="block" gap="small-300">
            <s-heading>{t("Variants")}</s-heading>
            <s-paragraph color="subdued">
              {hasVariants
                ? t("This product has multiple variants. Configure rental pricing and units for each one.")
                : t("If this product has variants in Shopify, click Sync variants to pull them in and price each one individually.")}
            </s-paragraph>
          </s-stack>
          <s-button onClick={onSync} loading={flag(syncing)}>{t("Sync variants")}</s-button>
        </s-stack>
        {hasVariants && variants.length > 0 && (
          <>
            <s-divider />
            <s-stack direction="block" gap="base">
              {variants.map((v) => (
                <VariantRowEditor
                  key={v.id}
                  productId={productId}
                  variant={v}
                  currency={currency}
                />
              ))}
            </s-stack>
          </>
        )}
      </s-stack>
    </s-section>
  );
}

function VariantRowEditor({
  productId: _productId,
  variant,
  currency,
}: {
  productId: string;
  variant: VariantRow;
  currency: string;
}) {
  const t = useT();
  const submit = useSubmit();
  const navigation = useNavigation();
  const saving =
    navigation.formData?.get("intent") === "save_variant" &&
    navigation.formData?.get("variantId") === variant.id;

  const [pricePerDay, setPricePerDay] = useState(variant.pricePerDay.toString());
  const [pricePerWeek, setPricePerWeek] = useState(variant.pricePerWeek.toString());
  const [pricePerMonth, setPricePerMonth] = useState(variant.pricePerMonth.toString());
  const [depositAmount, setDepositAmount] = useState(variant.depositAmount.toString());
  const [totalUnits, setTotalUnits] = useState(variant.totalUnits.toString());
  const [isActive, setIsActive] = useState(variant.isActive);

  function onSave() {
    const fd = new FormData();
    fd.set("intent", "save_variant");
    fd.set("variantId", variant.id);
    fd.set("pricePerDay", pricePerDay);
    fd.set("pricePerWeek", pricePerWeek);
    fd.set("pricePerMonth", pricePerMonth);
    fd.set("depositAmount", depositAmount);
    fd.set("totalUnits", totalUnits);
    fd.set("isActive", isActive.toString());
    submit(fd, { method: "POST" });
  }

  return (
    <s-box padding="base" borderRadius="base" background="subdued" border="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small-200" justifyContent="space-between" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>{variant.title}</s-heading>
            <s-badge tone={isActive ? "success" : undefined}>
              {isActive ? t("Active") : t("Inactive")}
            </s-badge>
          </s-stack>
          <VariantActiveCheckbox
            label={t("Available for rental")}
            checked={isActive}
            onChange={setIsActive}
          />
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-box minInlineSize="140px">
            <TextField
              label={t("Price per day")}
              type="number"
              value={pricePerDay}
              onChange={setPricePerDay}
              prefix={currency}
              min={0}
              step={0.01}
              autoComplete="off"
            />
          </s-box>
          <s-box minInlineSize="140px">
            <TextField
              label={t("Per week")}
              type="number"
              value={pricePerWeek}
              onChange={setPricePerWeek}
              prefix={currency}
              min={0}
              step={0.01}
              autoComplete="off"
            />
          </s-box>
          <s-box minInlineSize="140px">
            <TextField
              label={t("Per month")}
              type="number"
              value={pricePerMonth}
              onChange={setPricePerMonth}
              prefix={currency}
              min={0}
              step={0.01}
              autoComplete="off"
            />
          </s-box>
          <s-box minInlineSize="140px">
            <TextField
              label={t("Deposit")}
              type="number"
              value={depositAmount}
              onChange={setDepositAmount}
              prefix={currency}
              min={0}
              step={0.01}
              autoComplete="off"
            />
          </s-box>
          <s-box minInlineSize="120px">
            <TextField
              label={t("Units available")}
              type="number"
              value={totalUnits}
              onChange={setTotalUnits}
              min={1}
              autoComplete="off"
            />
          </s-box>
        </s-stack>
        <s-stack direction="inline">
          <s-button onClick={onSave} loading={flag(saving)} variant="primary">
            {t("Save variant")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

/**
 * Checkbox with a visually hidden label (Polaris React's `labelHidden`). The
 * shared adapter Checkbox has no such option, so this local copy binds the
 * `change` event the same way.
 */
function VariantActiveCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffectChange(ref, onChange);
  return (
    <s-checkbox
      ref={ref as never}
      label={label}
      labelAccessibilityVisibility="exclusive"
      checked={flag(checked)}
    />
  );
}

function useEffectChange(ref: React.RefObject<HTMLElement | null>, onChange: (v: boolean) => void) {
  useCustomEvent(ref, "change", (e) => {
    onChange(Boolean((e.currentTarget as unknown as { checked?: boolean }).checked));
  });
}
