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
  Select,
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
  const { session } = await authenticate.admin(request);
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
  pending:   { tone: "attention", label: "Pending payment" },
  confirmed: { tone: "info",      label: "Confirmed - not started yet" },
  active:    { tone: "success",   label: "Out on rental" },
  returned:  { tone: "success",   label: "Returned" },
  overdue:   { tone: "critical",  label: "Overdue - not returned" },
  cancelled: { tone: "subdued",   label: "Cancelled" },
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
  const [depositStatus, setDepositStatus] = useState(booking.depositStatus);

  const canMarkReturned = ["active", "overdue", "confirmed"].includes(booking.status);
  const canMarkActive = booking.status === "confirmed";
  const canMarkOverdue = booking.status === "active";
  const canCancel = ["pending", "confirmed"].includes(booking.status);

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
                      <Text as="h3" variant="headingSm">Update deposit status</Text>
                      <InlineStack gap="300" blockAlign="end">
                        <Box minWidth="200px">
                          <Select
                            label="Deposit status"
                            options={[
                              { label: "Held (awaiting return)", value: "held" },
                              { label: "Released (refunded to customer)", value: "released" },
                              { label: "Forfeited (damage or loss)", value: "forfeited" },
                            ]}
                            value={depositStatus}
                            onChange={setDepositStatus}
                          />
                        </Box>
                        <Form method="POST">
                          <input type="hidden" name="intent" value="update_deposit" />
                          <input type="hidden" name="depositStatus" value={depositStatus} />
                          <Button submit loading={submitting}>Update</Button>
                        </Form>
                      </InlineStack>
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
                  url={`mailto:${booking.customerEmail}`}
                  external
                  size="slim"
                >
                  Email customer
                </Button>
              </BlockStack>
            </Card>

            {/* Booking actions */}
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
