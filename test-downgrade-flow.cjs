// test-downgrade-flow.cjs
// End-to-end test for the downgrade-scheduled → downgrade-executed flow.
//
// What this does:
//   1. Creates a Stripe test clock
//   2. Creates a customer + attaches a test Visa card
//   3. Creates an ALL_MARKETS subscription
//   4. Inserts a row into the test sheet (so the webhook can find the subscriber)
//   5. Attaches a subscription schedule to downgrade to US_HK at period end
//   6. Waits for the DOWNGRADE_SCHEDULED webhook to fire and update the row
//   7. Advances the test clock past the period end
//   8. Waits for the two customer.subscription.updated events to be processed
//   9. Reads the final sheet state and prints PASS/FAIL
//  10. Deletes the test clock (cleans up customer + subscription too)
//
// Run from the Website/ directory:
//   node test-downgrade-flow.cjs

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const env  = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

const ENV = loadEnv();

const STRIPE_KEY        = ENV.STRIPE_SECRET_KEY;
const SHEET_ID          = '1ycnYJxGUAVBGo7eAUqbRycSyD2ONnA2nslnufMJdeog';
const SHEET_TAB         = 'Subscribers';
const ALL_MARKETS_PRICE = 'price_1SNau9PApeZiCPK22ZjuVaKQ';
const US_HK_PRICE       = 'price_1SNasAPApeZiCPK28bMFFYhP';
const SERVICE_ACCOUNT   = JSON.parse(ENV.GOOGLE_SERVICE_ACCOUNT_JSON);

// ── Stripe ───────────────────────────────────────────────────────────────────
const Stripe = require('stripe');
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

// ── Google Sheets ────────────────────────────────────────────────────────────
const { google } = require('googleapis');

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmt(date) {
  // Match the format the webhook uses: "25 May 2026 18:44"
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Singapore',
  });
}

async function appendRow(sheets, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:O`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

async function getRowBySubId(sheets, subId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:O`,
  });
  return (res.data.values || []).find(r => r[14] === subId) || null;
}

// Poll until the test clock is back to "ready" (all simulated time processed).
async function waitForClock(clockId) {
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === 'ready') return;
    process.stdout.write('.');
  }
  throw new Error('Test clock did not reach "ready" within 2 minutes');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Downgrade Flow Test ===');
  console.log('Testing: downgrade-executed should set Latest Action = DOWNGRADED,');
  console.log('         NOT overwrite it with DOWNGRADE_UNDONE.\n');

  const sheets = await getSheets();
  const now    = Math.floor(Date.now() / 1000);

  // ── 1. Test clock ───────────────────────────────────────────────────────
  process.stdout.write('1. Creating test clock ... ');
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: now,
    name: 'downgrade-executed-fix-test',
  });
  console.log(clock.id);

  try {
    // ── 2. Customer + payment method ──────────────────────────────────────
    process.stdout.write('2. Creating customer ... ');
    const customer = await stripe.customers.create({
      email: 'test-downgrade@rho-test.internal',
      name: 'Test Downgrade',
      test_clock: clock.id,
    });
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });
    console.log(customer.id);

    // ── 3. ALL_MARKETS subscription ───────────────────────────────────────
    process.stdout.write('3. Creating ALL_MARKETS subscription ... ');
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: ALL_MARKETS_PRICE }],
    });
    const periodEnd = sub.current_period_end;
    console.log(sub.id);
    console.log(`   Period end: ${new Date(periodEnd * 1000).toISOString()}`);

    // ── 4. Insert sheet row ───────────────────────────────────────────────
    process.stdout.write('4. Inserting test sheet row ... ');
    await appendRow(sheets, [
      'test-downgrade@rho-test.internal',  // A Email
      'Test Downgrade',                    // B Customer Name
      'TestTV',                            // C TradingView Username
      'TestTG',                            // D Telegram Username
      '',                                  // E Telegram User ID
      'ALL_MARKETS',                       // F Plan Type
      '388',                               // G Subscription Price
      '',                                  // H Previous Plan Type
      fmt(new Date(sub.start_date * 1000)),// I Subscription Start
      fmt(new Date(periodEnd * 1000)),     // J Subscription Expiry
      'ACTIVE',                            // K Status
      'NEW_SUBSCRIPTION',                  // L Latest Action
      '1',                                 // M Subscription Count
      '0',                                 // N Failed Payment Count
      sub.id,                              // O Stripe Subscription ID
    ]);
    console.log('done');

    // ── 5. Subscription schedule (downgrade ALL_MARKETS → US_HK) ─────────
    process.stdout.write('5. Creating downgrade schedule ... ');
    const rawSchedule = await stripe.subscriptionSchedules.create({
      from_subscription: sub.id,
    });
    await stripe.subscriptionSchedules.update(rawSchedule.id, {
      phases: [
        {
          items: [{ price: ALL_MARKETS_PRICE, quantity: 1 }],
          start_date: sub.current_period_start,
          end_date: periodEnd,
        },
        {
          items: [{ price: US_HK_PRICE, quantity: 1 }],
          start_date: periodEnd,
        },
      ],
    });
    console.log(rawSchedule.id);

    // Give the DOWNGRADE_SCHEDULED webhook time to hit Vercel and update the row.
    process.stdout.write('   Waiting 10s for DOWNGRADE_SCHEDULED webhook ... ');
    await sleep(10000);
    const rowAfterSchedule = await getRowBySubId(sheets, sub.id);
    console.log(`Latest Action = ${rowAfterSchedule ? rowAfterSchedule[11] : '(row not found)'}`);

    // ── 6. Advance clock past period end ──────────────────────────────────
    const advanceTo = periodEnd + 86400; // +1 day
    console.log(`6. Advancing clock to ${new Date(advanceTo * 1000).toISOString()} ...`);
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: advanceTo });
    process.stdout.write('   Polling until clock is ready');
    await waitForClock(clock.id);
    console.log(' ready');

    // Give Vercel time to process both customer.subscription.updated events.
    process.stdout.write('   Waiting 10s for webhook events to process ... ');
    await sleep(10000);
    console.log('done');

    // ── 7. Final result ───────────────────────────────────────────────────
    console.log('\n7. Final sheet state:');
    const row = await getRowBySubId(sheets, sub.id);
    if (!row) {
      console.log('   ERROR: row not found in sheet for', sub.id);
      return;
    }

    const planType    = row[5];   // F
    const prevPlan    = row[7];   // H
    const latestAction = row[11]; // L
    const status      = row[10];  // K

    console.log(`   Plan Type:      ${planType}`);
    console.log(`   Prev Plan Type: ${prevPlan}`);
    console.log(`   Latest Action:  ${latestAction}`);
    console.log(`   Status:         ${status}`);

    const planOk   = planType    === 'US_HK';
    const actionOk = latestAction === 'DOWNGRADED';
    const prevOk   = prevPlan    === 'ALL_MARKETS';

    console.log();
    if (planOk && actionOk && prevOk) {
      console.log('✓  PASS — Plan flipped to US_HK, Latest Action = DOWNGRADED, Previous Plan Type = ALL_MARKETS');
    } else {
      console.log('✗  FAIL');
      if (!planOk)   console.log(`   Expected Plan Type: US_HK, got: ${planType}`);
      if (!actionOk) console.log(`   Expected Latest Action: DOWNGRADED, got: ${latestAction}`);
      if (!prevOk)   console.log(`   Expected Prev Plan Type: ALL_MARKETS, got: ${prevPlan}`);
    }

  } finally {
    process.stdout.write('\n8. Deleting test clock (cleanup) ... ');
    await stripe.testHelpers.testClocks.del(clock.id);
    console.log('done');
  }
}

main().catch(err => {
  console.error('\nUnhandled error:', err.message || err);
  process.exit(1);
});
