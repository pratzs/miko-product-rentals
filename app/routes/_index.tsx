import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  // Forward all query params (shop, host, id_token, etc.) so /app can
  // identify the shop and validate the session token.
  const { searchParams } = new URL(request.url);
  return redirect(`/app?${searchParams.toString()}`);
};
