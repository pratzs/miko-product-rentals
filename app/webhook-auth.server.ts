import { authenticate } from "./shopify.server";

type WebhookContext = Awaited<ReturnType<typeof authenticate.webhook>>;

/**
 * authenticate.webhook, but immune to the expiring-offline-token poison loop.
 *
 * With `expiringOfflineAccessTokens` on, webhook auth loads the shop's
 * offline session and, if the token is expired, tries to REFRESH it. For an
 * uninstalled shop the grant is revoked, so the refresh fails and the library
 * throws a 500 Response -- before our handler ever runs. Seen live on
 * app/uninstalled: 8 consecutive 500 retries, and the very cleanup that would
 * delete the expired session (fixing the state) could never execute. The
 * GDPR webhooks are worse: shop/redact arrives 48h after uninstall, when the
 * token is always expired, so it would 500 forever.
 *
 * HMAC validation happens BEFORE any session/token logic and its rejections
 * are thrown 4xx Responses -- those still propagate so forged requests keep
 * getting rejected. Anything thrown after that point means "valid delivery,
 * no usable admin token", which is exactly the shape the library already
 * returns for a shop with no session at all -- so we degrade to that:
 * session/admin undefined, headers + parsed body supplying the rest.
 */
export async function authenticateWebhookSafe(request: Request): Promise<WebhookContext> {
  const fallbackClone = request.clone();
  try {
    return await authenticate.webhook(request);
  } catch (err) {
    if (err instanceof Response && err.status < 500) throw err;

    const shop = request.headers.get("x-shopify-shop-domain") ?? "";
    const topic = (request.headers.get("x-shopify-topic") ?? "").replace(/\//g, "_").toUpperCase();
    // This app has no observability.server, so log a greppable line instead.
    console.error(`[webhook] ${topic} ${shop}: auth degraded (offline token refresh failed), continuing without a session`, err);
    const payload = await fallbackClone.json().catch(() => ({}));
    return {
      apiVersion: request.headers.get("x-shopify-api-version") ?? "",
      shop,
      topic,
      webhookId: request.headers.get("x-shopify-webhook-id") ?? "",
      payload,
      subTopic: undefined,
      session: undefined,
      admin: undefined,
    } as unknown as WebhookContext;
  }
}
