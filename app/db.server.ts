import { PrismaClient } from "@prisma/client";

declare global {
  var prismaClient: PrismaClient | undefined;
}

export const db =
  global.prismaClient ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaClient = db;
}

/**
 * P2002-safe upsert of the shop's single ShopConfig row.
 *
 * First launch: the app layout loader, afterAuth (shop name, currency, merchant
 * contact) and the page loaders run in parallel and can all try to create the
 * same row. Postgres lets one win and the others fail with P2002 (unique
 * constraint on shop), which surfaced as an HTTP 500 on install (App Store
 * review, 2 Oct 2026). The row now exists, so apply the `update` half instead,
 * which is exactly what the upsert would have done had it run second.
 */
export async function upsertShopConfig(args: {
  where: { shop: string };
  create: Parameters<typeof db.shopConfig.create>[0]["data"];
  update: Parameters<typeof db.shopConfig.update>[0]["data"];
}) {
  try {
    return await db.shopConfig.upsert(args);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return db.shopConfig.update({ where: args.where, data: args.update });
    }
    throw err;
  }
}
