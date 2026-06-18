import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

/**
 * Fires when the merchant approves or adjusts the granted access scopes
 * (managed install / token rotation). Keep the local session scope in sync
 * so middleware and feature gates know what we're allowed to call.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

  if (topic !== "APP_SCOPES_UPDATE") {
    return json({ ok: true });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const current = (payload as any)?.current as string[] | undefined;
    if (session && current) {
      await db.session.update({
        where: { id: session.id },
        data: { scope: current.join(",") },
      });
    }
    console.log(`[webhook] APP_SCOPES_UPDATE for ${shop}`);
  } catch (err) {
    console.error(`[webhook] APP_SCOPES_UPDATE failed for ${shop}:`, err);
  }

  return json({ ok: true });
};
