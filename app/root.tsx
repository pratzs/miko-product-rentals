import type { LoaderFunctionArgs, HeadersFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useRouteError } from "@remix-run/react";
import { addDocumentResponseHeaders } from "./shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const responseHeaders = new Headers();
  addDocumentResponseHeaders(request, responseHeaders);
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" }, { headers: responseHeaders });
};

export const headers: HeadersFunction = ({ loaderHeaders }) => {
  return loaderHeaders;
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* App Bridge must be the FIRST script in the document head for its
            web-vitals collection to measure correctly. Polaris web components
            load straight after it, exactly once: two Polaris bundles throw.
            polaris-2.js is the 2.x channel. It follows the merchant's admin at
            runtime through App Bridge (new admin look on the new admin, the
            previous look on the previous one). Rollback target if a later 2.x
            minor misbehaves: polaris-2.0.js (frozen). */}
        <meta name="shopify-api-key" content={apiKey} />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} />
        <script src="https://cdn.shopify.com/shopifycloud/polaris-2.js" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  // Suppress 401/302 during App Bridge token exchange — it re-authenticates automatically.
  if (error instanceof Response && (error.status === 401 || error.status === 302)) {
    return null;
  }
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Something went wrong</title>
      </head>
      <body>
        <div style={{ padding: "2rem", fontFamily: "sans-serif", textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p>Please refresh the page or return to the app from your Shopify admin.</p>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
