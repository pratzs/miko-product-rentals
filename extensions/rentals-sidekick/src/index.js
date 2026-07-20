/**
 * Sidekick data extension for Miko Product Rentals.
 *
 * Each tool is a thin pass-through to /app/api/sidekick, which does the Prisma
 * work and enforces the row caps. Shopify attaches the session token because
 * the request goes to the app's own domain; the backend verifies it with
 * authenticate.admin and replies through the cors() helper. Read-only.
 */

const ENDPOINT = '/app/api/sidekick';

async function callTool(tool, input = {}) {
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      // Forward the whole input so availability gets query + from/to/units.
      body: JSON.stringify({tool, ...input}),
    });
    if (!response.ok) return {results: []};
    return await response.json();
  } catch {
    return {results: []};
  }
}

export default async function extension() {
  shopify.tools.register('list_upcoming_bookings', () =>
    callTool('list_upcoming_bookings'),
  );
  shopify.tools.register('list_active_rentals', () =>
    callTool('list_active_rentals'),
  );
  shopify.tools.register('list_overdue_rentals', () =>
    callTool('list_overdue_rentals'),
  );
  shopify.tools.register('find_customer_bookings', (input) =>
    callTool('find_customer_bookings', input),
  );
  shopify.tools.register('list_rental_products', (input) =>
    callTool('list_rental_products', input),
  );
  shopify.tools.register('get_rental_revenue', () =>
    callTool('get_rental_revenue'),
  );
  shopify.tools.register('check_availability', (input) =>
    callTool('check_availability', input),
  );
}
