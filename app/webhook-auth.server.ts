import { authenticate } from "./shopify.server";
import { isValidWebhookHmac } from "./webhook-hmac.server";

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
 * The library's HMAC rejections are thrown 4xx Responses -- those still
 * propagate. For anything else we re-verify the HMAC ourselves (see below)
 * and only then treat it as "valid delivery, no usable admin token", which is
 * exactly the shape the library already returns for a shop with no session
 * at all: session/admin undefined, headers + parsed body supplying the rest.
 */
export async function authenticateWebhookSafe(request: Request): Promise<WebhookContext> {
  const fallbackClone = request.clone();
  try {
    return await authenticate.webhook(request);
  } catch (err) {
    if (err instanceof Response && err.status < 500) throw err;

    // The library reads the request body BEFORE it validates the HMAC, so an
    // error thrown here does not prove the delivery was signed (a caller can
    // make the body read fail). Verify the signature ourselves before trusting
    // a single header: no valid HMAC, no degraded context.
    let rawBody: string;
    try {
      rawBody = await fallbackClone.text();
    } catch {
      throw new Response(undefined, { status: 400, statusText: "Bad Request" });
    }
    if (
      !isValidWebhookHmac(
        rawBody,
        request.headers.get("x-shopify-hmac-sha256"),
        process.env.SHOPIFY_API_SECRET,
      )
    ) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }

    const shop = request.headers.get("x-shopify-shop-domain") ?? "";
    const topic = (request.headers.get("x-shopify-topic") ?? "").replace(/\//g, "_").toUpperCase();
    // This app has no observability.server, so log a greppable line instead.
    console.error(`[webhook] ${topic} ${shop}: auth degraded (offline token refresh failed), continuing without a session`, err);
    let payload: unknown = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = {};
    }
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
