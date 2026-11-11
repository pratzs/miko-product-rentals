# Deployment Guide — Miko Product Rentals

## 1. Shopify Partner Dashboard

1. Go to partners.shopify.com → Apps → Create app → Create app manually
2. App name: **Miko Product Rentals**
3. Copy the **Client ID** and **Client secret**
4. Open `shopify.app.toml` and paste the Client ID into the `client_id` field
5. Under "App URL" in the dashboard, set it to your Railway URL (you'll get this in step 3)
6. Under "Allowed redirection URLs" add: `https://YOUR_RAILWAY_URL/auth/callback`

## 2. Create Railway Project

1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select `pratzs/miko-product-rentals`
3. Railway will detect the Dockerfile automatically

### Add a PostgreSQL database

In your Railway project: → Add Service → Database → PostgreSQL

Copy the `DATABASE_URL` from the PostgreSQL service's Variables tab.

### Set environment variables

In your Railway service → Variables → Add the following:

```
SHOPIFY_API_KEY=<Client ID from Partner dashboard>
SHOPIFY_API_SECRET=<Client secret from Partner dashboard>
SHOPIFY_APP_URL=https://<your-railway-domain>.railway.app
DATABASE_URL=<from PostgreSQL service above>
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
SENDER_EMAIL=rentals@yourdomain.com
SENDER_NAME=Your Store Name
CRON_SECRET=<any random string, e.g. from: openssl rand -hex 32>
```

### Set the deploy command

In Railway → Settings → Deploy:
- Start command: `npm run docker-start`

## 3. Run database migrations

After the first successful deploy, open a Railway shell or run via CLI:

```bash
railway run npx prisma db push
```

## 4. Shopify Theme App Extension

After the app is deployed and linked to a Partner app:

```bash
cd /path/to/miko-product-rentals
shopify app deploy
```

This deploys the `rental-calendar` extension. Then in the Shopify Theme Editor:
1. Go to your store → Online Store → Themes → Customize
2. Navigate to a product page template
3. Add a block → Apps → Miko Rental Calendar
4. Set the **App URL** in the block settings to your Railway URL

## 5. Daily cron job

Set up an external cron to POST to your cron endpoint once per day:

```
POST https://YOUR_RAILWAY_URL/api/cron/daily
Authorization: Bearer YOUR_CRON_SECRET
```

You can use:
- **Railway** → Add Service → Cron → Schedule: `0 8 * * *` (8am UTC daily)
  - Command: `curl -X POST https://YOUR_URL/api/cron/daily -H "Authorization: Bearer YOUR_CRON_SECRET"`
- Or any external cron service (cron-job.org, etc.)

## 6. Link the Shopify app

```bash
shopify app config link
```

Follow the prompts to connect your local `shopify.app.toml` to the Partner dashboard app.

## 7. Releasing a change to how rentals are priced at checkout

The price a shopper pays for a rental is set by the Cart Transform Function
(`extensions/miko-cart-transform`, Rust, built by `shopify app deploy`). It never
takes a price from the cart. It recomputes it from the merchant's rates, which
the server publishes to app-owned metafields (`$app:miko_rentals.config`) on each
rental product and variant. A rental line whose metafield is missing is charged
the variant's normal price.

That makes the order of a release matter:

1. **Server first (Railway).** On boot it publishes every shop's rates (about a
   minute after start, then every 6 hours, and on every save in the app).
2. **Confirm every shop is published.** Either read the Railway log line
   `[rental-config/tick] N/N shops fully synced`, or ask for a report:
   `curl -X POST https://YOUR_URL/api/cron/rental-config -H "Authorization: Bearer YOUR_CRON_SECRET"`
   `shopsFullySynced` must equal `shops` and every `errors` list must be empty.
3. **Then `shopify app deploy`** (function and theme extension).

Never deploy the function before the server has published the rates: until the
metafields exist, every rental would be charged the normal product price.

The machine that runs `shopify app deploy` needs Rust with the WASI target:
`rustup target add wasm32-wasip1`.

Before any change to the function, run `npm run test:cartsecurity` (it builds
the function natively and compares it with the JavaScript reference on tens of
thousands of carts) and measure the instruction count on a large cart with
`shopify app function run --path extensions/miko-cart-transform --input cart.json --json`.
Shopify discards the function's whole output above 11 million instructions.

## Done!

Your app will be live at `https://YOUR_RAILWAY_URL/app` when installed on a store.
