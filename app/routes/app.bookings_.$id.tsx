import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, Form, useActionData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, differenceInDays } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { useState } from "react";
import { Banner, Grid, TextField, badgeTone, flag } from "../components/polaris";
import { MAIN_WITH_SIDEBAR } from "../components/layout";
import { useT } from "../i18n/context";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, booking] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalBooking.findFirst({
      where: { id: params.id, shop },
      include: {
        rentalProduct: true,
        rentalVariant: true,
      },
    }),
  ]);

  if (!booking) throw new Response("Not found", { status: 404 });

  const daysOverdue =
    booking.status === "overdue" || (booking.status === "active" && new Date() > booking.endDate)
      ? differenceInDays(new Date(), booking.endDate)
      : 0;

  return json({
    currency: config?.currency || "USD",
    lateFeePerDay: config?.lateFeePerDay || 0,
    booking: {
      id: booking.id,
      orderName: booking.shopifyOrderName,
      shopifyOrderId: booking.shopifyOrderId,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      productTitle: booking.rentalProduct.shopifyProductTitle,
      productId: booking.rentalProductId,
      variantTitle: booking.rentalVariant?.shopifyVariantTitle ?? null,
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      rentalDays: booking.rentalDays,
      rentalPrice: booking.rentalPrice,
      depositAmount: booking.depositAmount,
      depositStatus: booking.depositStatus,
      totalCharged: booking.totalCharged,
      status: booking.status,
      lateFeeCharged: booking.lateFeeCharged,
      lateFeeInvoiceUrl: booking.lateFeeInvoiceId
        ? `https://${shop}/admin/draft_orders/${booking.lateFeeInvoiceId.split("/").pop()}`
        : null,
      merchantNotes: booking.merchantNotes,
      returnedAt: booking.returnedAt?.toISOString() || null,
      cancelledAt: booking.cancelledAt?.toISOString() || null,
      createdAt: booking.createdAt.toISOString(),
    },
    daysOverdue,
  });
};

// Pushes a Shopify refund for the booking's deposit amount against the
// original payment transaction. The caller is responsible for updating the
// booking's depositStatus on success - we return ok/error instead of throwing
// so both the "Refund deposit" button and the auto-refund-on-return path can
// share this and degrade gracefully when there is no captured payment to
// refund (e.g. Cash on Delivery orders).
type RefundResult = { ok: true } | { ok: false; error: string };
async function refundBookingDeposit(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  booking: { id: string; shopifyOrderId: string | null; shopifyOrderName: string | null; depositAmount: number },
): Promise<RefundResult> {
  if (!booking.shopifyOrderId) {
    return { ok: false, error: "no Shopify order linked" };
  }
  const orderGid = `gid://shopify/Order/${booking.shopifyOrderId}`;
  const orderRes = await admin.graphql(
    `#graphql
      query OrderForRefund($id: ID!) {
        order(id: $id) {
          id
          currencyCode
          transactions(first: 10) {
            id
            kind
            status
            gateway
            parentTransaction { id }
          }
        }
      }`,
    { variables: { id: orderGid } },
  );
  const orderData = (await orderRes.json()) as {
    data?: {
      order?: {
        currencyCode: string;
        transactions: Array<{ id: string; kind: string; status: string; gateway: string }>;
      };
    };
  };
  const order = orderData.data?.order;
  if (!order) return { ok: false, error: "could not find the Shopify order" };
  const captureTxn = order.transactions.find(
    (t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS",
  );
  if (!captureTxn) {
    return { ok: false, error: "no captured payment to refund against" };
  }
  const idempotencyKey = `miko-deposit-refund-${booking.id}`;
  try {
    const refundRes = await admin.graphql(
      `#graphql
        mutation RefundDeposit($input: RefundInput!, $key: String!) {
          refundCreate(input: $input) @idempotent(key: $key) {
            refund { id }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          key: idempotencyKey,
          input: {
            orderId: orderGid,
            note: `Deposit refund for rental ${booking.shopifyOrderName || ""} (booking ${booking.id.slice(-8).toUpperCase()})`.trim(),
            notify: true,
            transactions: [
              {
                amount: booking.depositAmount.toFixed(2),
                gateway: captureTxn.gateway,
                kind: "REFUND",
                orderId: orderGid,
                parentId: captureTxn.id,
              },
            ],
          },
        },
      },
    );
    const refundData = (await refundRes.json()) as {
      data?: {
        refundCreate?: {
          refund: { id: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
    };
    const errors = refundData.data?.refundCreate?.userErrors ?? [];
    if (errors.length > 0) {
      return { ok: false, error: errors.map((e) => e.message).join(", ") };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "request failed";
    console.error(`[deposit-refund] booking ${booking.id} failed:`, err);
    return { ok: false, error: msg };
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const booking = await db.rentalBooking.findFirst({
    where: { id: params.id, shop },
    include: { rentalProduct: true },
  });
  if (!booking) return json({ error: "Booking not found." }, { status: 404 });

  const config = await db.shopConfig.findUnique({ where: { shop } });

  if (intent === "mark_returned") {
    // A deposit is "settled" when the merchant has already made a deliberate
    // decision: either forfeited (customer damaged/lost item) or released
    // (already refunded). In both cases, mark_returned must not touch the
    // deposit — we never override an explicit merchant decision.
    // For any other held deposit we always try to refund automatically so
    // the merchant doesn't need a separate step.
    const depositSettled = ["released", "forfeited"].includes(booking.depositStatus);
    const hasDeposit = booking.depositAmount > 0 && !depositSettled;

    // Flip status first so the booking shows as returned even if the refund
    // call hits a transient error. The merchant can always retry from the
    // Deposit management section.
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { status: "returned", returnedAt: new Date() },
    });

    let extraKey = "";
    let extraParams: Record<string, string> = {};
    if (hasDeposit && booking.shopifyOrderId) {
      // Always auto-refund the deposit unless the merchant explicitly forfeited it.
      const result = await refundBookingDeposit(admin, booking);
      if (result.ok) {
        await db.rentalBooking.update({
          where: { id: booking.id },
          data: { depositStatus: "released" },
        });
        extraKey = " Deposit of {amount} was refunded to the customer.";
        extraParams = { amount: formatCurrency(booking.depositAmount, config?.currency || "USD") };
      } else {
        extraKey = " Could not auto-refund the deposit ({error}). Open Deposit management to refund manually.";
        extraParams = { error: String(result.error) };
      }
    } else if (hasDeposit) {
      // No Shopify order linked (e.g. legacy / manually created booking).
      // Mark released so the status is not left as "held" indefinitely.
      await db.rentalBooking.update({
        where: { id: booking.id },
        data: { depositStatus: "released" },
      });
      extraKey = " Deposit marked as released. Refund the customer manually in Shopify if needed.";
    }

    // The banner is translated at the RENDER site: the English text is the
    // catalog key and the values travel separately, so a merchant on a
    // German admin gets a German confirmation instead of English prose.
    return json({
      success: true,
      message: "Booking marked as returned.",
      extraKey,
      extraParams,
    });
  }

  if (intent === "mark_active") {
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { status: "active" },
    });
    return json({ success: true, message: "Booking is now marked as active." });
  }

  if (intent === "mark_overdue") {
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { status: "overdue" },
    });
    return json({ success: true, message: "Booking marked as overdue." });
  }

  if (intent === "cancel") {
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    return json({ success: true, message: "Booking canceled." });
  }

  if (intent === "update_deposit") {
    const depositStatus = formData.get("depositStatus") as string;
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { depositStatus },
    });
    return json({ success: true, message: "Deposit status updated." });
  }

  if (intent === "refund_deposit") {
    if (!booking.shopifyOrderId) {
      return json({ error: "No Shopify order is linked to this booking, so it cannot be refunded." }, { status: 400 });
    }
    if (booking.depositAmount <= 0) {
      return json({ error: "No deposit on this booking to refund." }, { status: 400 });
    }
    if (booking.depositStatus === "released") {
      return json({ error: "Deposit has already been released." }, { status: 400 });
    }

    const result = await refundBookingDeposit(admin, booking);
    if (!result.ok) {
      return json({ error: "Refund failed: {error}.", errorParams: { error: String(result.error) } }, { status: 400 });
    }
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { depositStatus: "released" },
    });
    return json({
      success: true,
      message: "Deposit of {amount} refunded to the customer.",
      messageParams: { amount: formatCurrency(booking.depositAmount, config?.currency || "USD") },
    });
  }

  if (intent === "charge_late_fee") {
    const daysOverdue = differenceInDays(new Date(), booking.endDate);
    const lateFeeTotal = (config?.lateFeePerDay || 0) * Math.max(0, daysOverdue - (config?.gracePeriodDays || 0));

    if (lateFeeTotal <= 0) {
      return json({ error: "No late fee to charge yet (within grace period)." }, { status: 400 });
    }

    // Create a Shopify draft order for the late fee so the merchant can
    // review and send the payment link directly to the customer from Shopify admin.
    let draftOrderAdminUrl: string | null = null;
    try {
      const draftRes = await admin.graphql(
        `#graphql
          mutation CreateLatFeeDraftOrder($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id legacyResourceId }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            input: {
              lineItems: [
                {
                  title: `Late fee - ${booking.shopifyOrderName || booking.id.slice(-8).toUpperCase()} (${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue)`,
                  quantity: 1,
                  originalUnitPrice: lateFeeTotal.toFixed(2),
                  requiresShipping: false,
                  taxable: false,
                },
              ],
              ...(booking.customerEmail ? { email: booking.customerEmail } : {}),
              note: `Late return fee for booking ${booking.shopifyOrderName || booking.id}. Originally due ${new Date(booking.endDate).toLocaleDateString()}.`,
              tags: ["miko-late-fee", `booking-${booking.id.slice(-8).toLowerCase()}`],
            },
          },
        },
      );
      const draftData = (await draftRes.json()) as {
        data?: {
          draftOrderCreate?: {
            draftOrder?: { id: string; legacyResourceId: string };
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };
      };
      const draft = draftData.data?.draftOrderCreate?.draftOrder;
      if (draft?.legacyResourceId) {
        draftOrderAdminUrl = `https://${shop}/admin/draft_orders/${draft.legacyResourceId}`;
        await db.rentalBooking.update({
          where: { id: booking.id },
          data: { lateFeeCharged: lateFeeTotal, lateFeeInvoiceId: draft.id },
        });
      } else {
        const errors = draftData.data?.draftOrderCreate?.userErrors ?? [];
        console.error("[late-fee] draftOrderCreate errors:", errors);
        // Fall back: record locally even if draft order creation failed.
        await db.rentalBooking.update({
          where: { id: booking.id },
          data: { lateFeeCharged: lateFeeTotal },
        });
      }
    } catch (err) {
      console.error("[late-fee] failed to create draft order:", err);
      await db.rentalBooking.update({
        where: { id: booking.id },
        data: { lateFeeCharged: lateFeeTotal },
      });
    }

    const currency = config?.currency || "USD";
    return json({
      success: true,
      message: draftOrderAdminUrl
        ? "Late fee of {amount} recorded. A draft order has been created, open it in Shopify to send the payment link to the customer."
        : "Late fee of {amount} recorded. Create a manual invoice in Shopify to charge the customer.",
      messageParams: { amount: formatCurrency(lateFeeTotal, currency) },
      draftOrderUrl: draftOrderAdminUrl,
    });
  }

  if (intent === "save_notes") {
    const merchantNotes = formData.get("merchantNotes") as string;
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { merchantNotes },
    });
    return json({ success: true, message: "Notes saved." });
  }

  return json({ error: "Unknown action." }, { status: 400 });
};

const STATUS_BADGE: Record<string, { tone: string; label: string }> = {
  pending:      { tone: "attention", label: "Pending payment" },
  confirmed:    { tone: "info",      label: "Confirmed, not started yet" },
  active:       { tone: "success",   label: "Out on rental" },
  returned:     { tone: "success",   label: "Returned" },
  overdue:      { tone: "critical",  label: "Overdue, not returned" },
  cancelled:    { tone: "subdued",   label: "Canceled" },
  needs_review: { tone: "warning",   label: "Needs review, overbooked" },
};

const DEPOSIT_BADGE: Record<string, { tone: string; label: string }> = {
  pending:   { tone: "attention", label: "Deposit held" },
  held:      { tone: "info",      label: "Deposit held" },
  released:  { tone: "success",   label: "Deposit released" },
  forfeited: { tone: "critical",  label: "Deposit forfeited" },
};

export default function BookingDetailPage() {
  const { booking, currency, lateFeePerDay, daysOverdue } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const t = useT();
  const submitting = navigation.state === "submitting";

  const [notes, setNotes] = useState(booking.merchantNotes);

  const canMarkReturned = ["active", "overdue", "confirmed"].includes(booking.status);
  const canMarkActive = booking.status === "confirmed";
  const canMarkOverdue = booking.status === "active";
  const canCancel = ["pending", "confirmed", "needs_review"].includes(booking.status);

  /** One label/value line in the summary cards. */
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <s-stack direction="inline" justifyContent="space-between" gap="base">
      <s-text color="subdued">{label}</s-text>
      {children}
    </s-stack>
  );

  return (
    <s-page
      heading={booking.orderName || t("Booking {id}", { id: booking.id.slice(-8).toUpperCase() })}
      inlineSize="large"
    >
      <s-link
        slot="breadcrumb-actions"
        href="/app/bookings"
        onClick={(e: { preventDefault: () => void; metaKey?: boolean; ctrlKey?: boolean }) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          navigate("/app/bookings");
        }}
      >
        {t("Bookings")}
      </s-link>
      <s-stack direction="block" gap="base">
        <s-text color="subdued">{`${booking.productTitle} - ${booking.customerName}`}</s-text>
        <Grid columns={MAIN_WITH_SIDEBAR} gap="base">
          <s-stack direction="block" gap="base">
            {actionData && "error" in actionData && (
              <Banner tone="critical" title={t(actionData.error, (actionData as any).errorParams)} />
            )}
            {actionData && "message" in actionData && (
              <Banner
                tone="success"
                title={
                  t((actionData as any).message, (actionData as any).messageParams) +
                  ((actionData as any).extraKey
                    ? t((actionData as any).extraKey, (actionData as any).extraParams)
                    : "")
                }
                action={
                  (actionData as any).draftOrderUrl
                    ? {
                        content: t("Open draft order in Shopify to send payment link"),
                        url: (actionData as any).draftOrderUrl,
                        external: true,
                      }
                    : undefined
                }
              />
            )}

            {booking.status === "overdue" && (
              <Banner
                tone="critical"
                title={
                  daysOverdue > 1
                    ? t("This rental is {n} days overdue", { n: daysOverdue })
                    : t("This rental is {n} day overdue", { n: daysOverdue })
                }
              >
                <s-paragraph>
                  {lateFeePerDay > 0
                    ? t("A late fee of {amount} per day applies.", { amount: formatCurrency(lateFeePerDay, currency) })
                    : t("Contact the customer to arrange return.")}
                </s-paragraph>
              </Banner>
            )}

            {booking.status === "needs_review" && (
              <Banner tone="warning" title={t("This booking needs your review")}>
                <s-paragraph>
                  {booking.merchantNotes ||
                    t("Capacity conflict at the time the order came in. Resolve by contacting the customer or adjusting another booking.")}
                </s-paragraph>
              </Banner>
            )}

            {/* Booking summary */}
            <s-section>
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="start" gap="base">
                  <s-stack direction="block" gap="small-300">
                    <s-heading>{booking.productTitle}</s-heading>
                    {booking.variantTitle && (
                      <s-paragraph color="subdued">{t("Variant: {title}", { title: booking.variantTitle })}</s-paragraph>
                    )}
                    <s-paragraph color="subdued">{booking.orderName}</s-paragraph>
                  </s-stack>
                  <s-badge tone={badgeTone(STATUS_BADGE[booking.status]?.tone)}>
                    {t(STATUS_BADGE[booking.status]?.label ?? "")}
                  </s-badge>
                </s-stack>
                <s-divider />
                <s-stack direction="inline" gap="large">
                  <s-stack direction="block" gap="none">
                    <s-text color="subdued">{t("Rental starts")}</s-text>
                    <s-text fontWeight="medium">
                      {format(new Date(booking.startDate), "EEEE, d MMMM yyyy")}
                    </s-text>
                  </s-stack>
                  <s-stack direction="block" gap="none">
                    <s-text color="subdued">{t("Returns by")}</s-text>
                    <s-text fontWeight="medium">
                      {format(new Date(booking.endDate), "EEEE, d MMMM yyyy")}
                    </s-text>
                  </s-stack>
                  <s-stack direction="block" gap="none">
                    <s-text color="subdued">{t("Duration")}</s-text>
                    <s-text>{t("{n} days", { n: booking.rentalDays })}</s-text>
                  </s-stack>
                  {booking.returnedAt && (
                    <s-stack direction="block" gap="none">
                      <s-text color="subdued">{t("Returned on")}</s-text>
                      <s-text>{format(new Date(booking.returnedAt), "d MMM yyyy")}</s-text>
                    </s-stack>
                  )}
                </s-stack>
              </s-stack>
            </s-section>

            {/* Financial summary */}
            <s-section heading={t("Payment summary")}>
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-200">
                  <Row label={t("Rental fee")}>
                    <s-text>{formatCurrency(booking.rentalPrice, currency)}</s-text>
                  </Row>
                  {booking.depositAmount > 0 && (
                    <s-stack direction="inline" justifyContent="space-between" gap="base">
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-text color="subdued">{t("Deposit")}</s-text>
                        <s-badge tone={badgeTone(DEPOSIT_BADGE[booking.depositStatus]?.tone || "subdued")}>
                          {DEPOSIT_BADGE[booking.depositStatus]?.label
                            ? t(DEPOSIT_BADGE[booking.depositStatus].label)
                            : booking.depositStatus}
                        </s-badge>
                      </s-stack>
                      <s-text>{formatCurrency(booking.depositAmount, currency)}</s-text>
                    </s-stack>
                  )}
                  {booking.lateFeeCharged > 0 && (
                    <Row label={t("Late fee charged")}>
                      <s-text tone="critical">{formatCurrency(booking.lateFeeCharged, currency)}</s-text>
                    </Row>
                  )}
                  <s-divider />
                  <s-stack direction="inline" justifyContent="space-between" gap="base">
                    <s-text fontWeight="semibold">{t("Total charged at checkout")}</s-text>
                    <s-text fontWeight="semibold">
                      {formatCurrency(booking.totalCharged, currency)}
                    </s-text>
                  </s-stack>
                </s-stack>

                {booking.depositAmount > 0 && (
                  <>
                    <s-divider />
                    <s-stack direction="block" gap="small">
                      <s-heading>{t("Deposit management")}</s-heading>
                      {booking.depositStatus === "released" ? (
                        <Banner
                          tone="success"
                          title={t("Deposit of {amount} has been released to the customer.", {
                            amount: formatCurrency(booking.depositAmount, currency),
                          })}
                        />
                      ) : booking.depositStatus === "forfeited" ? (
                        <Banner tone="critical" title={t("Deposit forfeited")}>
                          <s-paragraph>{t("The deposit has been kept and not refunded to the customer.")}</s-paragraph>
                        </Banner>
                      ) : (
                        <s-stack direction="block" gap="small">
                          <s-paragraph color="subdued">
                            {t("The {amount} deposit is currently held. Refund it directly to the customer's original payment method, or mark it forfeited if the item was damaged or lost.", { amount: formatCurrency(booking.depositAmount, currency) })}
                          </s-paragraph>
                          <s-stack direction="inline" gap="small-200" alignItems="center">
                            <Form method="POST">
                              <input type="hidden" name="intent" value="refund_deposit" />
                              <s-button type="submit" loading={flag(submitting)} variant="primary">
                                {t("Refund {amount} to customer", { amount: formatCurrency(booking.depositAmount, currency) })}
                              </s-button>
                            </Form>
                            <Form method="POST">
                              <input type="hidden" name="intent" value="update_deposit" />
                              <input type="hidden" name="depositStatus" value="forfeited" />
                              <s-button type="submit" loading={flag(submitting)} tone="critical" variant="tertiary">
                                {t("Mark forfeited (keep deposit)")}
                              </s-button>
                            </Form>
                          </s-stack>
                          <s-paragraph color="subdued">
                            {t("Refunds use the customer's original payment method through Shopify. The customer will be notified by email.")}
                          </s-paragraph>
                        </s-stack>
                      )}
                    </s-stack>
                  </>
                )}
              </s-stack>
            </s-section>

            {/* Late fees */}
            {(booking.status === "overdue" || daysOverdue > 0) && lateFeePerDay > 0 && (
              <s-section heading={t("Late fees")}>
                <s-stack direction="block" gap="base">
                  <s-paragraph color="subdued">
                    {daysOverdue > 1
                      ? t("This rental is {n} days overdue. At {fee}/day, the total late fee is", {
                          n: daysOverdue,
                          fee: formatCurrency(lateFeePerDay, currency),
                        })
                      : t("This rental is {n} day overdue. At {fee}/day, the total late fee is", {
                          n: daysOverdue,
                          fee: formatCurrency(lateFeePerDay, currency),
                        })}{" "}
                    <s-text type="strong">{formatCurrency(lateFeePerDay * daysOverdue, currency)}</s-text>.
                  </s-paragraph>
                  {booking.lateFeeCharged > 0 ? (
                    <Banner
                      tone="success"
                      title={t("Late fee of {amount} has been recorded.", {
                        amount: formatCurrency(booking.lateFeeCharged, currency),
                      })}
                      action={
                        booking.lateFeeInvoiceUrl
                          ? {
                              content: t("Open draft order in Shopify →"),
                              url: booking.lateFeeInvoiceUrl,
                              external: true,
                            }
                          : undefined
                      }
                    >
                      {booking.lateFeeInvoiceUrl ? (
                        <s-paragraph>{t("A draft order was created in Shopify. Open it to review and send the payment link to the customer.")}</s-paragraph>
                      ) : (
                        <s-paragraph>{t("Create a draft order or invoice in Shopify to charge this to the customer.")}</s-paragraph>
                      )}
                    </Banner>
                  ) : (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="charge_late_fee" />
                      <s-button tone="critical" type="submit" loading={flag(submitting)}>
                        {t("Record late fee ({amount})", { amount: formatCurrency(lateFeePerDay * daysOverdue, currency) })}
                      </s-button>
                    </Form>
                  )}
                </s-stack>
              </s-section>
            )}

            {/* Merchant notes */}
            <s-section heading={t("Internal notes")}>
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">{t("Only you can see these notes. They are never shown to the customer.")}</s-paragraph>
                <TextField
                  label={t("Notes")}
                  labelHidden
                  value={notes}
                  onChange={setNotes}
                  multiline={4}
                  autoComplete="off"
                  placeholder={t("Add any notes about this booking, pickup, return condition, etc.")}
                />
                <Form method="POST">
                  <input type="hidden" name="intent" value="save_notes" />
                  <input type="hidden" name="merchantNotes" value={notes} />
                  <s-button type="submit" loading={flag(submitting)}>{t("Save notes")}</s-button>
                </Form>
              </s-stack>
            </s-section>
          </s-stack>

          {/* Sidebar - actions */}
          <s-stack direction="block" gap="base">
            {/* Customer info */}
            <s-section heading={t("Customer")}>
              <s-stack direction="block" gap="small">
                <s-stack direction="block" gap="small-300">
                  <s-text fontWeight="medium">{booking.customerName}</s-text>
                  <s-text color="subdued">{booking.customerEmail}</s-text>
                  {booking.customerPhone && (
                    <s-text color="subdued">{booking.customerPhone}</s-text>
                  )}
                </s-stack>
                <s-stack direction="inline">
                  <s-button
                    disabled={flag(!booking.customerEmail)}
                    onClick={() => {
                      if (!booking.customerEmail) return;
                      // Pre-fill the booking context so the merchant doesn't
                      // have to re-type any of it.
                      const subject = t("Regarding your rental {order}", { order: booking.orderName || "" }).trim();
                      const startStr = format(new Date(booking.startDate), "d MMM yyyy");
                      const endStr = format(new Date(booking.endDate), "d MMM yyyy");
                      const body = [
                        t("Hi {name},", { name: booking.customerName.split(" ")[0] || t("there") }),
                        "",
                        t("Reaching out about your booking for {product} ({start} to {end}).", {
                          product: booking.productTitle,
                          start: startStr,
                          end: endStr,
                        }),
                        "",
                        "",
                      ].join("\n");
                      const href =
                        `mailto:${booking.customerEmail}` +
                        `?subject=${encodeURIComponent(subject)}` +
                        `&body=${encodeURIComponent(body)}`;
                      // Embedded apps run in an iframe — target the top window
                      // so the OS-level mail client actually opens.
                      try {
                        if (window.top) {
                          window.top.location.href = href;
                        } else {
                          window.location.href = href;
                        }
                      } catch {
                        window.location.href = href;
                      }
                    }}
                  >
                    {t("Email customer")}
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>

            {/* Booking actions */}
            {(canMarkActive || canMarkReturned || canMarkOverdue || canCancel) ? (
              <s-section heading={t("Actions")}>
                <s-stack direction="block" gap="small">
                  {canMarkActive && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="mark_active" />
                      <s-button inlineSize="fill" type="submit" loading={flag(submitting)} variant="primary">
                        {t("Mark as started (item handed over)")}
                      </s-button>
                    </Form>
                  )}

                  {canMarkReturned && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="mark_returned" />
                      <s-button inlineSize="fill" type="submit" loading={flag(submitting)} variant="primary">
                        {t("Mark as returned")}
                      </s-button>
                    </Form>
                  )}

                  {canMarkOverdue && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="mark_overdue" />
                      <s-button inlineSize="fill" type="submit" loading={flag(submitting)} tone="critical">
                        {t("Mark as overdue")}
                      </s-button>
                    </Form>
                  )}

                  {canCancel && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="cancel" />
                      <s-button inlineSize="fill" type="submit" loading={flag(submitting)} variant="tertiary" tone="critical">
                        {t("Cancel booking")}
                      </s-button>
                    </Form>
                  )}
                </s-stack>
              </s-section>
            ) : (
              <s-section heading={t("Actions")}>
                <s-paragraph color="subdued">
                  {booking.status === "returned"
                    ? t("This rental has been returned and the booking is complete. No further actions are needed.")
                    : booking.status === "cancelled"
                    ? t("This booking was canceled. No further actions are available.")
                    : t("No actions are available for this booking right now.")}
                </s-paragraph>
              </s-section>
            )}

            {/* Booking metadata */}
            <s-section heading={t("Details")}>
              <s-stack direction="block" gap="small-300">
                <Row label={t("Booked on")}>
                  <s-text>{format(new Date(booking.createdAt), "d MMM yyyy")}</s-text>
                </Row>
                <Row label={t("Booking ID")}>
                  <s-text>{booking.id.slice(-8).toUpperCase()}</s-text>
                </Row>
                {booking.shopifyOrderId && (
                  <Row label={t("Shopify order")}>
                    <s-text>{booking.orderName}</s-text>
                  </Row>
                )}
              </s-stack>
            </s-section>
          </s-stack>
        </Grid>
      </s-stack>
    </s-page>
  );
}
