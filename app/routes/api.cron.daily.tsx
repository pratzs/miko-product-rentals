import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "../db.server";
import { sendReturnReminder, sendOverdueNotice } from "../utils/email";
import { addDays, startOfDay, endOfDay } from "date-fns";

/**
 * Daily cron endpoint — call this once per day via Railway cron or an external scheduler.
 * Protected by a shared secret set in CRON_SECRET env variable.
 *
 * What it does:
 * 1. Transitions "confirmed" bookings to "active" when the start date has passed.
 * 2. Transitions "active" bookings to "overdue" when the end date has passed.
 * 3. Sends return reminder emails for bookings due tomorrow.
 * 4. Sends overdue notice emails for newly overdue bookings (first time only).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomorrowStart = startOfDay(addDays(now, 1));
  const tomorrowEnd = endOfDay(addDays(now, 1));

  const results = {
    activatedBookings: 0,
    overdueBookings: 0,
    remindersSent: 0,
    overdueNoticesSent: 0,
    errors: [] as string[],
  };

  // 1. confirmed → active (start date has arrived)
  const toActivate = await db.rentalBooking.findMany({
    where: {
      status: "confirmed",
      startDate: { lte: now },
    },
    select: { id: true },
  });

  if (toActivate.length > 0) {
    await db.rentalBooking.updateMany({
      where: { id: { in: toActivate.map((b) => b.id) } },
      data: { status: "active" },
    });
    results.activatedBookings = toActivate.length;
  }

  // 2. active → overdue (end date has passed)
  const toOverdue = await db.rentalBooking.findMany({
    where: {
      status: "active",
      endDate: { lt: todayStart },
    },
    select: { id: true, shop: true, customerEmail: true, customerName: true, endDate: true, rentalProductId: true },
  });

  if (toOverdue.length > 0) {
    await db.rentalBooking.updateMany({
      where: { id: { in: toOverdue.map((b) => b.id) } },
      data: { status: "overdue" },
    });
    results.overdueBookings = toOverdue.length;

    // Send overdue notices (only if no previous overdue email sent for this booking)
    for (const booking of toOverdue) {
      try {
        const [config, product, alreadySent] = await Promise.all([
          db.shopConfig.findUnique({ where: { shop: booking.shop } }),
          db.rentalProduct.findUnique({ where: { id: booking.rentalProductId } }),
          db.emailLog.findFirst({
            where: { shop: booking.shop, bookingId: booking.id, type: "overdue" },
          }),
        ]);

        if (!alreadySent && booking.customerEmail && product) {
          const lateFeePerDay = config?.lateFeePerDay || 0;
          await sendOverdueNotice(
            booking.shop,
            booking.id,
            booking.customerName,
            booking.customerEmail,
            product.shopifyProductTitle,
            booking.endDate,
            lateFeePerDay,
            config?.currency || "USD",
          );
          results.overdueNoticesSent++;
        }
      } catch (e: any) {
        results.errors.push(`Overdue notice for booking ${booking.id}: ${e.message}`);
      }
    }
  }

  // 3. Send return reminders for bookings due tomorrow
  const dueTomorrow = await db.rentalBooking.findMany({
    where: {
      status: "active",
      endDate: { gte: tomorrowStart, lte: tomorrowEnd },
    },
    include: { rentalProduct: true },
  });

  for (const booking of dueTomorrow) {
    try {
      const [config, alreadySent] = await Promise.all([
        db.shopConfig.findUnique({ where: { shop: booking.shop } }),
        db.emailLog.findFirst({
          where: { shop: booking.shop, bookingId: booking.id, type: "return_reminder" },
        }),
      ]);

      if (!alreadySent && booking.customerEmail) {
        await sendReturnReminder(
          booking.shop,
          booking.id,
          booking.customerName,
          booking.customerEmail,
          booking.rentalProduct.shopifyProductTitle,
          booking.endDate,
          config?.currency || "USD",
        );
        results.remindersSent++;
      }
    } catch (e: any) {
      results.errors.push(`Return reminder for booking ${booking.id}: ${e.message}`);
    }
  }

  return json({ ok: true, ...results });
};
