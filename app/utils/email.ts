// Email notifications are handled natively through Shopify admin.
// These stubs keep call sites intact without sending anything.

export interface BookingEmailData {
  shop: string;
  bookingId: string;
  customerName: string;
  customerEmail: string;
  productTitle: string;
  startDate: Date;
  endDate: Date;
  rentalDays: number;
  rentalPrice: number;
  depositAmount: number;
  totalCharged: number;
  orderName: string;
  currency: string;
}

export async function sendBookingConfirmation(_data: BookingEmailData) {}

export async function sendReturnReminder(
  _shop: string,
  _bookingId: string,
  _customerName: string,
  _customerEmail: string,
  _productTitle: string,
  _endDate: Date,
  _currency: string,
) {}

export async function sendOverdueNotice(
  _shop: string,
  _bookingId: string,
  _customerName: string,
  _customerEmail: string,
  _productTitle: string,
  _endDate: Date,
  _lateFeePerDay: number,
  _currency: string,
) {}
