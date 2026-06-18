import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, Form, useActionData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Divider,
  Box,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { format, differenceInDays } from "date-fns";
import { formatCurrency } from "../utils/pricing";
import { useState } from "react";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, booking] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
    db.rentalBooking.findFirst({
      where: { id: params.id, shop },
      include: {
        rentalProduct: true,
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
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      rentalDays: booking.rentalDays,
      rentalPrice: booking.rentalPrice,
      depositAmount: booking.depositAmount,
      depositStatus: booking.depositStatus,
      totalCharged: booking.totalCharged,
      status: booking.status,
      lateFeeCharged: booking.lateFeeCharged,
      merchantNotes: booking.merchantNotes,
      returnedAt: booking.returnedAt?.toISOString() || null,
      cancelledAt: booking.cancelledAt?.toISOString() || null,
      createdAt: booking.createdAt.toISOString(),
    },
    daysOverdue,
  });
};

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
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: {
        status: "returned",
        returnedAt: new Date(),
        depositStatus: booking.rentalProduct.autoReleaseDeposit ? "released" : booking.depositStatus,
      },
    });
    return json({ success: true, message: `Booking marked as returned.${booking.rentalProduct.autoReleaseDeposit && booking.depositAmount > 0 ? " Deposit marked as released - process the refund in Shopify." : ""}` });
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
    return json({ success: true, message: "Booking cancelled." });
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
      return json({ error: "No Shopify order linked to this booking - cannot refund." }, { status: 400 });
    }
    if (booking.depositAmount <= 0) {
      return json({ error: "No deposit on this booking to refund." }, { status: 400 });
    }
    if (booking.depositStatus === "released") {
      return json({ error: "Deposit has already been released." }, { status: 400 });
    }

    const orderGid = `gid://shopify/Order/${booking.shopifyOrderId}`;
    // Look up the order to find its currency and primary transaction (we'll
    // refund against the original payment transaction).
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
    if (!order) {
      return json({ error: "Could not find the Shopify order." }, { status: 400 });
    }
    const captureTxn = order.transactions.find(
      (t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS",
    );
    if (!captureTxn) {
      return json(
        {
          error:
            "No successful payment found on this order. If payment was taken outside Shopify, mark the deposit released manually.",
        },
        { status: 400 },
      );
    }

    // 2026-04 API requires @idempotent on refundCreate. We derive the key
    // deterministically from the booking id so retrying the same click never
    // creates duplicate refunds - the second call is a no-op on Shopify's side.
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
              note: `Deposit refund for rental ${booking.shopifyOrderName} (booking ${booking.id.slice(-8).toUpperCase()})`,
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
        return json(
          { error: `Refund failed: ${errors.map((e) => e.message).join(", ")}` },
          { status: 400 },
        );
      }
    } catch (err) {
      // Any GraphQL or network error surfaces as a banner instead of crashing
      // the route.
      const msg = err instanceof Error ? err.message : "Refund request failed.";
      console.error(`[deposit-refund] booking ${booking.id} failed:`, err);
      return json(
        { error: `Refund request failed: ${msg}` },
        { status: 500 },
      );
    }

    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { depositStatus: "released" },
    });
    return json({
      success: true,
      message: `Deposit of ${formatCurrency(booking.depositAmount, config?.currency || "USD")} refunded to the customer.`,
    });
  }

  if (intent === "charge_late_fee") {
    const daysOverdue = differenceInDays(new Date(), booking.endDate);
    const lateFeeTotal = (config?.lateFeePerDay || 0) * Math.max(0, daysOverdue - (config?.gracePeriodDays || 0));
    await db.rentalBooking.update({
      where: { id: booking.id },
      data: { lateFeeCharged: lateFeeTotal },
    });
    return json({ success: true, message: `Late fee of ${formatCurrency(lateFeeTotal, config?.currency || "USD")} recorded. Create a manual invoice in Shopify to charge the customer.` });
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

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
  pending:      { tone: "attention", label: "Pending payment" },
  confirmed:    { tone: "info",      label: "Confirmed - not started yet" },
  active:       { tone: "success",   label: "Out on rental" },
  returned:     { tone: "success",   label: "Returned" },
  overdue:      { tone: "critical",  label: "Overdue - not returned" },
  cancelled:    { tone: "subdued",   label: "Cancelled" },
  needs_review: { tone: "warning",   label: "Needs review - overbooked" },
};

const DEPOSIT_BADGE: Record<string, { tone: any; label: string }> = {
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
  const submitting = navigation.state === "submitting";

  const [notes, setNotes] = useState(booking.merchantNotes);

  const canMarkReturned = ["active", "overdue", "confirmed"].includes(booking.status);
  const canMarkActive = booking.status === "confirmed";
  const canMarkOverdue = booking.status === "active";
  const canCancel = ["pending", "confirmed", "needs_review"].includes(booking.status);

  return (
    <Page
      title={booking.orderName || `Booking ${booking.id.slice(-8).toUpperCase()}`}
      subtitle={`${booking.productTitle} - ${booking.customerName}`}
      backAction={{ content: "Bookings", url: "/app/bookings" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {actionData && "error" in actionData && (
              <Banner tone="critical" title={actionData.error} />
            )}
            {actionData && "message" in actionData && (
              <Banner tone="success" title={(actionData as any).message} />
            )}

            {booking.status === "overdue" && (
              <Banner tone="critical" title={`This rental is ${daysOverdue} day${daysOverdue > 1 ? "s" : ""} overdue`}>
                <p>
                  {lateFeePerDay > 0
                    ? `A late fee of ${formatCurrency(lateFeePerDay, currency)} per day applies.`
                    : "Contact the customer to arrange return."}
                </p>
              </Banner>
            )}

            {booking.status === "needs_review" && (
              <Banner tone="warning" title="This booking needs your review">
                <p>
                  {booking.merchantNotes ||
                    "Capacity conflict at the time the order came in. Resolve by contacting the customer or adjusting another booking."}
                </p>
              </Banner>
            )}

            {/* Booking summary */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="start">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">{booking.productTitle}</Text>
                    <Text as="p" tone="subdued">{booking.orderName}</Text>
                  </BlockStack>
                  <Badge tone={STATUS_BADGE[booking.status]?.tone}>
                    {STATUS_BADGE[booking.status]?.label}
                  </Badge>
                </InlineStack>
                <Divider />
                <InlineStack gap="600" wrap>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">Rental starts</Text>
                    <Text as="p" variant="bodyMd" fontWeight="medium">
                      {format(new Date(booking.startDate), "EEEE, d MMMM yyyy")}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">Returns by</Text>
                    <Text as="p" variant="bodyMd" fontWeight="medium">
                      {format(new Date(booking.endDate), "EEEE, d MMMM yyyy")}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">Duration</Text>
                    <Text as="p" variant="bodyMd">{booking.rentalDays} days</Text>
                  </BlockStack>
                  {booking.returnedAt && (
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Returned on</Text>
                      <Text as="p" variant="bodyMd">
                        {format(new Date(booking.returnedAt), "d MMM yyyy")}
                      </Text>
                    </BlockStack>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Financial summary */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Payment summary</Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">Rental fee</Text>
                    <Text as="p">{formatCurrency(booking.rentalPrice, currency)}</Text>
                  </InlineStack>
                  {booking.depositAmount > 0 && (
                    <InlineStack align="space-between">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="p" tone="subdued">Deposit</Text>
                        <Badge tone={DEPOSIT_BADGE[booking.depositStatus]?.tone || "subdued"}>
                          {DEPOSIT_BADGE[booking.depositStatus]?.label || booking.depositStatus}
                        </Badge>
                      </InlineStack>
                      <Text as="p">{formatCurrency(booking.depositAmount, currency)}</Text>
                    </InlineStack>
                  )}
                  {booking.lateFeeCharged > 0 && (
                    <InlineStack align="space-between">
                      <Text as="p" tone="subdued">Late fee charged</Text>
                      <Text as="p" tone="critical">{formatCurrency(booking.lateFeeCharged, currency)}</Text>
                    </InlineStack>
                  )}
                  <Divider />
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">Total charged at checkout</Text>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {formatCurrency(booking.totalCharged, currency)}
                    </Text>
                  </InlineStack>
                </BlockStack>

                {booking.depositAmount > 0 && (
                  <>
                    <Divider />
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">Deposit management</Text>
                      {booking.depositStatus === "released" ? (
                        <Banner tone="success" title={`Deposit of ${formatCurrency(booking.depositAmount, currency)} has been released to the customer.`} />
                      ) : booking.depositStatus === "forfeited" ? (
                        <Banner tone="critical" title="Deposit forfeited">
                          <p>The deposit has been kept and not refunded to the customer.</p>
                        </Banner>
                      ) : (
                        <BlockStack gap="300">
                          <Text as="p" tone="subdued">
                            The {formatCurrency(booking.depositAmount, currency)} deposit is currently held. Refund it directly to the customer's original payment method, or mark it forfeited if the item was damaged or lost.
                          </Text>
                          <InlineStack gap="200" wrap>
                            <Form method="POST">
                              <input type="hidden" name="intent" value="refund_deposit" />
                              <Button submit loading={submitting} variant="primary">
                                Refund {formatCurrency(booking.depositAmount, currency)} to customer
                              </Button>
                            </Form>
                            <Form method="POST">
                              <input type="hidden" name="intent" value="update_deposit" />
                              <input type="hidden" name="depositStatus" value="forfeited" />
                              <Button submit loading={submitting} tone="critical" variant="plain">
                                Mark forfeited (keep deposit)
                              </Button>
                            </Form>
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Refunds use the customer's original payment method through Shopify. The customer will be notified by email.
                          </Text>
                        </BlockStack>
                      )}
                    </BlockStack>
                  </>
                )}
              </BlockStack>
            </Card>

            {/* Late fees */}
            {(booking.status === "overdue" || daysOverdue > 0) && lateFeePerDay > 0 && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Late fees</Text>
                  <Text as="p" tone="subdued">
                    This rental is {daysOverdue} day{daysOverdue > 1 ? "s" : ""} overdue.
                    At {formatCurrency(lateFeePerDay, currency)}/day, the total late fee is{" "}
                    <strong>{formatCurrency(lateFeePerDay * daysOverdue, currency)}</strong>.
                  </Text>
                  {booking.lateFeeCharged > 0 ? (
                    <Banner tone="success" title={`Late fee of ${formatCurrency(booking.lateFeeCharged, currency)} has been recorded.`}>
                      <p>Create a draft order or invoice in Shopify to charge this to the customer.</p>
                    </Banner>
                  ) : (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="charge_late_fee" />
                      <Button tone="critical" submit loading={submitting}>
                        Record late fee ({formatCurrency(lateFeePerDay * daysOverdue, currency)})
                      </Button>
                    </Form>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Merchant notes */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Internal notes</Text>
                <Text as="p" tone="subdued">These notes are only visible to you - not to the customer.</Text>
                <TextField
                  label="Notes"
                  labelHidden
                  value={notes}
                  onChange={setNotes}
                  multiline={4}
                  autoComplete="off"
                  placeholder="Add any notes about this booking, pickup, return condition, etc."
                />
                <Form method="POST">
                  <input type="hidden" name="intent" value="save_notes" />
                  <input type="hidden" name="merchantNotes" value={notes} />
                  <Button submit loading={submitting} size="slim">Save notes</Button>
                </Form>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

        {/* Sidebar - actions */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Customer info */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Customer</Text>
                <BlockStack gap="100">
                  <Text as="p" fontWeight="medium">{booking.customerName}</Text>
                  <Text as="p" tone="subdued">{booking.customerEmail}</Text>
                  {booking.customerPhone && (
                    <Text as="p" tone="subdued">{booking.customerPhone}</Text>
                  )}
                </BlockStack>
                <Button
                  size="slim"
                  disabled={!booking.customerEmail}
                  onClick={() => {
                    if (!booking.customerEmail) return;
                    // Pre-fill the booking context so the merchant doesn't
                    // have to re-type any of it.
                    const subject = `Regarding your rental ${booking.orderName || ""}`.trim();
                    const startStr = format(new Date(booking.startDate), "d MMM yyyy");
                    const endStr = format(new Date(booking.endDate), "d MMM yyyy");
                    const body = [
                      `Hi ${booking.customerName.split(" ")[0] || "there"},`,
                      "",
                      `Reaching out about your booking for ${booking.productTitle} (${startStr} to ${endStr}).`,
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
                  Email customer
                </Button>
              </BlockStack>
            </Card>

            {/* Booking actions */}
            {(canMarkActive || canMarkReturned || canMarkOverdue || canCancel) ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Actions</Text>

                  {canMarkActive && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="mark_active" />
                      <Button fullWidth submit loading={submitting} variant="primary">
                        Mark as started (item handed over)
                      </Button>
                    </Form>
                  )}

                  {canMarkReturned && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="mark_returned" />
                      <Button fullWidth submit loading={submitting} variant="primary">
                        Mark as returned
                      </Button>
                    </Form>
                  )}

                  {canMarkOverdue && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="mark_overdue" />
                      <Button fullWidth submit loading={submitting} tone="critical">
                        Mark as overdue
                      </Button>
                    </Form>
                  )}

                  {canCancel && (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="cancel" />
                      <Button fullWidth submit loading={submitting} variant="plain" tone="critical">
                        Cancel booking
                      </Button>
                    </Form>
                  )}
                </BlockStack>
              </Card>
            ) : (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Actions</Text>
                  <Text as="p" tone="subdued">
                    {booking.status === "returned"
                      ? "This rental has been returned and the booking is complete. No further actions are needed."
                      : booking.status === "cancelled"
                      ? "This booking was cancelled. No further actions are available."
                      : "No actions are available for this booking right now."}
                  </Text>
                </BlockStack>
              </Card>
            )}

            {/* Booking metadata */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Details</Text>
                <BlockStack gap="100">
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">Booked on</Text>
                    <Text as="p">{format(new Date(booking.createdAt), "d MMM yyyy")}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">Booking ID</Text>
                    <Text as="p">{booking.id.slice(-8).toUpperCase()}</Text>
                  </InlineStack>
                  {booking.shopifyOrderId && (
                    <InlineStack align="space-between">
                      <Text as="p" tone="subdued">Shopify order</Text>
                      <Text as="p">{booking.orderName}</Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
