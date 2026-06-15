import type { PrismaClient } from "@prisma/client";

export const PLANS = {
  free: {
    name: "Free",
    price: 0,
    rentalLimit: 10,
    limitType: "lifetime" as const,
    badge: true,
  },
  starter: {
    name: "Starter",
    price: 19.95,
    rentalLimit: 50,
    limitType: "monthly" as const,
    badge: false,
  },
  growth: {
    name: "Growth",
    price: 49.95,
    rentalLimit: 200,
    limitType: "monthly" as const,
    badge: false,
  },
  pro: {
    name: "Pro",
    price: 89.95,
    rentalLimit: 500,
    limitType: "monthly" as const,
    badge: false,
  },
} as const;

export type PlanName = keyof typeof PLANS;

export function getPlan(planName: string): (typeof PLANS)[PlanName] {
  return PLANS[(planName as PlanName)] ?? PLANS.free;
}

/**
 * Check if a shop has hit its rental limit.
 * Free: counts all-time confirmed+active+returned+overdue bookings (lifetime).
 * Paid: counts bookings created in the current calendar month with those statuses.
 */
export async function checkRentalLimit(
  shop: string,
  planName: string,
  db: PrismaClient,
): Promise<{ allowed: boolean; current: number; limit: number; resetDate?: Date }> {
  const plan = getPlan(planName);
  const limit = plan.rentalLimit;

  const excludedStatuses = ["cancelled", "pending"];

  let current: number;
  let resetDate: Date | undefined;

  if (plan.limitType === "lifetime") {
    current = await db.rentalBooking.count({
      where: {
        shop,
        status: { notIn: excludedStatuses },
      },
    });
  } else {
    // Monthly - count bookings created this calendar month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    current = await db.rentalBooking.count({
      where: {
        shop,
        status: { notIn: excludedStatuses },
        createdAt: { gte: monthStart, lt: monthEnd },
      },
    });

    resetDate = monthEnd;
  }

  return {
    allowed: current < limit,
    current,
    limit,
    ...(resetDate ? { resetDate } : {}),
  };
}

export function hasSmtp(planName: string): boolean {
  return planName !== "free";
}

export function hasBadge(planName: string): boolean {
  return planName === "free";
}
