import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.js' {
  interface ListOverdueRentalsInput {
    [k: string]: unknown;
  }

  interface ListOverdueRentalsOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface ListActiveRentalsInput {
    [k: string]: unknown;
  }

  interface ListActiveRentalsOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface ListUpcomingBookingsInput {
    [k: string]: unknown;
  }

  interface ListUpcomingBookingsOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface CheckAvailabilityInput {
    /**
     * Rental product name, e.g. 'DJ controller'
     */
    query: string;
    /**
     * Start date in YYYY-MM-DD. Defaults to today.
     */
    from?: string;
    /**
     * End date in YYYY-MM-DD. Defaults to a week from the start.
     */
    to?: string;
    /**
     * How many units are needed. Defaults to 1.
     */
    units?: number;
    [k: string]: unknown;
  }

  interface CheckAvailabilityOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface FindCustomerBookingsInput {
    /**
     * Customer name or email to search for
     */
    query: string;
    [k: string]: unknown;
  }

  interface FindCustomerBookingsOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface ListRentalProductsInput {
    /**
     * Optional product name to filter by. Omit to list all.
     */
    query?: string;
    [k: string]: unknown;
  }

  interface ListRentalProductsOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface GetRentalRevenueInput {
    [k: string]: unknown;
  }

  interface GetRentalRevenueOutput {
    results?: {
      uri: string;
      name?: string;
      type: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface ShopifyTools {
    /**
     * List rentals that are past their due date and have not been returned, with the customer, contact, and how late they are. Use whenever the merchant asks what is overdue, what is late, what has not come back, or who still has the merchant's gear.
     */
    register(
      name: 'list_overdue_rentals',
      handler: (
        input: ListOverdueRentalsInput,
      ) => ListOverdueRentalsOutput | Promise<ListOverdueRentalsOutput>,
    );
    /**
     * List rentals that are currently out with a customer right now, with who has what and when it is due back. Use when the merchant asks what is out, what is currently rented, or what is due back soon.
     */
    register(
      name: 'list_active_rentals',
      handler: (
        input: ListActiveRentalsInput,
      ) => ListActiveRentalsOutput | Promise<ListActiveRentalsOutput>,
    );
    /**
     * List upcoming rental bookings that have not started yet, ordered by start date, with customer and dates. Use when the merchant asks what is coming up, upcoming rentals, or what is booked for the next while.
     */
    register(
      name: 'list_upcoming_bookings',
      handler: (
        input: ListUpcomingBookingsInput,
      ) => ListUpcomingBookingsOutput | Promise<ListUpcomingBookingsOutput>,
    );
    /**
     * Check whether a rental product is available for a date range, returning how many units are free. Use when the merchant asks if an item is available, free, or bookable for given dates. Pass the product name as query, and optional from and to dates.
     */
    register(
      name: 'check_availability',
      handler: (
        input: CheckAvailabilityInput,
      ) => CheckAvailabilityOutput | Promise<CheckAvailabilityOutput>,
    );
    /**
     * Find all rental bookings for a customer by name or email, across every status. Use when the merchant asks about a specific customer's rentals or history.
     */
    register(
      name: 'find_customer_bookings',
      handler: (
        input: FindCustomerBookingsInput,
      ) => FindCustomerBookingsOutput | Promise<FindCustomerBookingsOutput>,
    );
    /**
     * List the products set up for rental, with their unit count, daily price, and deposit. Use when the merchant asks what they rent out, their rental catalogue, or how a rental item is priced. Pass an optional product name to filter.
     */
    register(
      name: 'list_rental_products',
      handler: (
        input: ListRentalProductsInput,
      ) => ListRentalProductsOutput | Promise<ListRentalProductsOutput>,
    );
    /**
     * Report this month's rental revenue, the number of bookings, and the total value of deposits currently held. Use when the merchant asks about rental income, revenue, earnings this month, or held deposits.
     */
    register(
      name: 'get_rental_revenue',
      handler: (
        input: GetRentalRevenueInput,
      ) => GetRentalRevenueOutput | Promise<GetRentalRevenueOutput>,
    );
  }

  const shopify: import('@shopify/ui-extensions/admin.app.tools.data').Api & {
    tools: ShopifyTools;
  };
  const globalThis: { shopify: typeof shopify };
}
