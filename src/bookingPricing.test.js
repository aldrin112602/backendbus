const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { calculateBookingPrice, receiptPricingRows } = require('./bookingPricing');
const { validateSeats } = require('./seatPolicy');
const { seatErrorStatus } = require('./seatPolicyService');

for (const type of ['pwd', 'student', 'senior_citizen']) {
  test(`${type}: 20% applies to the whole booking`, () => {
    const result = calculateBookingPrice(100, 2, { status: 'approved', type });
    assert.equal(result.subtotal, 200);
    assert.equal(result.discount_amount, 40);
    assert.equal(result.amount, 160);
    assert.equal(result.discount_type, type);
    assert.match(receiptPricingRows(result), /20%/);
  });
}
for (const status of ['pending', 'rejected', 'none']) {
  test(`${status}: no discount`, () => assert.equal(calculateBookingPrice(100, 2, { status, type: 'pwd' }).amount, 200));
}
test('rounding reconciles subtotal, discount and payment in cents', () => {
  const result = calculateBookingPrice(10.03, 3, { status: 'approved', type: 'student' });
  assert.equal(result.subtotal, 30.09);
  assert.equal(result.discount_amount, 6.02);
  assert.equal(result.amount, 24.07);
});
test('historical records never invent pricing', () => assert.match(receiptPricingRows({ amount: 160 }), /Detailed fare breakdown unavailable/));
test('invalid pricing is rejected', () => {
  assert.throws(() => calculateBookingPrice(NaN, 2));
  assert.throws(() => calculateBookingPrice(100, 0));
});

const source = fs.readFileSync(require.resolve('./server'), 'utf8');
function route(start, end, context = {}) {
  let handler;
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  vm.runInNewContext(source.slice(a, b), { app: { post: (_, fn) => { handler = fn; } }, ...context });
  return handler;
}
function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('direct regular booking rejects cash, omitted and online methods', async () => {
  const handler = route("app.post('/api/client/booking',", '// Save / update passenger pickup location');
  for (const payment_method of ['cash', undefined, 'online']) {
    const res = response();
    await handler({ body: { payment_method } }, res);
    assert.equal(res.code, 400);
  }
});

function checkoutHarness({ conflict = false, stripeFails = false, stripeError = null, sessionSaveFails = false, discountStatus = 'approved' } = {}) {
  const inserts = [];
  const charges = [];
  const updates = [];
  const expired = [];
  let availabilitySyncs = 0;
  const supabase = { from(table) {
    const query = {
      select() { return this; }, eq() { return this; },
      insert(payload) { if (table === 'bookings') inserts.push(payload); return this; },
      update(payload) {
        if (table === 'bookings') updates.push(payload);
        this.updateResult = sessionSaveFails && payload.checkout_session_id
          ? { error: new Error('Could not save checkout session') }
          : { error: null, data: payload.status === 'cancelled' ? [{ id: 'new-reference' }] : null };
        return this;
      },
      then(resolve, reject) { return Promise.resolve(this.updateResult || { error: null }).then(resolve, reject); },
      single: async () => ({ data: table === 'users' ? { id: 'user' } : table === 'buses' ? { route_id: 'route' } : table === 'routes' ? { name: 'Test', fare_per_seat: 100 } : { id: 'new-reference', ...inserts.at(-1) } }),
      maybeSingle: async () => ({ data: discountStatus === 'approved' ? { status: 'approved', type: 'pwd' } : null }),
    };
    return query;
  } };
  const handler = route("app.post('/api/client/create-payment-session',", '// Stripe webhook endpoint', {
    supabase, supabaseAdmin: supabase, calculateBookingPrice, validateSeats, seatErrorStatus,
    seatPolicy: {
      actor: async () => ({ id: '12345678-1234-4123-8123-123456789012', email: 'test@example.test' }),
      context: async () => ({ bus: { total_seats: 40 }, category: discountStatus === 'approved' ? 'pwd' : null, otherPrioritySeat: false }),
    },
    stripe: { checkout: { sessions: {
      create: async data => { charges.push(data); if (stripeError) throw stripeError; if (stripeFails) throw Error('Checkout unavailable'); return { id: 'session', url: 'https://checkout.example.test' }; },
      expire: async id => { expired.push(id); },
    } } },
    findSeatConflicts: async () => conflict ? [1] : [],
    getTripAvailability: async () => ({ available_seats: 10, available_standing: 4 }),
    syncBusAvailability: async () => { availabilitySyncs++; },
    process: { env: { FRONTEND_URL: 'https://example.test' } }, console: { error() {} },
  });
  return { handler, inserts, charges, updates, expired, get availabilitySyncs() { return availabilitySyncs; } };
}
const request = () => ({ body: { userId: '12345678-1234-4123-8123-123456789012', email: 'test@example.test', busId: 'bus', seats: [9, 10], date: '2026-10-10', totalAmount: 1 } });
test('checkout stores current server pricing and charges that same amount', async () => {
  const h = checkoutHarness(); const res = response();
  await h.handler(request(), res);
  assert.equal(res.code, 200);
  assert.equal(h.inserts[0].amount, 160);
  assert.equal(h.inserts[0].discount_amount, 40);
  assert.equal(h.inserts[0].payment_method, 'online');
  assert.equal(h.charges[0].line_items[0].price_data.unit_amount, 16000);
});
test('unverified checkout charges full fare', async () => {
  const h = checkoutHarness({ discountStatus: 'pending' }); const res = response();
  await h.handler(request(), res);
  assert.equal(h.inserts[0].amount, 200);
});
test('taken seats cannot create a booking or charge', async () => {
  const h = checkoutHarness({ conflict: true }); const res = response();
  await h.handler(request(), res);
  assert.equal(res.code, 409); assert.equal(h.inserts.length, 0); assert.equal(h.charges.length, 0);
});
test('checkout provider failure returns an error, not success', async () => {
  const h = checkoutHarness({ stripeFails: true }); const res = response();
  await h.handler(request(), res);
  assert.equal(res.code, 500); assert.equal(res.body.error, 'Checkout unavailable');
  assert.equal(h.updates.at(-1).status, 'cancelled');
  assert.equal(h.availabilitySyncs, 2);
});
test('Stripe minimum rejection cancels the pending booking and returns a clear error', async () => {
  const stripeError = Object.assign(new Error('Amount too small'), { code: 'amount_too_small' });
  const h = checkoutHarness({ stripeError }); const res = response();
  await h.handler(request(), res);
  assert.equal(res.code, 500);
  assert.match(res.body.error, /below the current card payment minimum/);
  assert.equal(res.body.bookingReleased, true);
  assert.equal(h.updates.at(-1).status, 'cancelled');
});
test('failed checkout session save expires Stripe session and releases booking', async () => {
  const h = checkoutHarness({ sessionSaveFails: true }); const res = response();
  await h.handler(request(), res);
  assert.equal(res.code, 500);
  assert.deepEqual(h.expired, ['session']);
  assert.equal(h.updates.at(-1).status, 'cancelled');
  assert.equal(h.availabilitySyncs, 2);
});
test('pickup requests retain cash without reserving seats', async () => {
  let handler; let inserted;
  const query = {
    select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; },
    limit: async () => ({ data: [] }),
    insert(payload) { inserted = payload; return this; },
    single: async () => ({ data: { id: 'pickup', ...inserted } }),
  };
  vm.runInNewContext(source.slice(source.indexOf("app.post('/api/client/pickup-request',")), {
    app: { post: (_, fn) => { handler = fn; } }, supabaseAdmin: { from: () => query }, supabase: { from: () => query }, seatErrorStatus, seatPolicy: { actor: async () => ({ id: 'user', email: 'test@example.test' }) },
  });
  const res = response();
  await handler({ body: { userId: 'user', busId: 'bus' } }, res);
  assert.equal(res.code, 201);
  assert.equal(inserted.payment_method, 'cash');
  assert.equal(inserted.booking_type, 'pickup_request');
  assert.equal(inserted.seat_assignment, 'unassigned');
  assert.equal(inserted.seats.length, 0);
});

for (const scenario of [
  { seats: [1], discountStatus: 'approved', status: 403 },
  { seats: [5], discountStatus: 'pending', status: 403 },
  { seats: [5, 6], discountStatus: 'approved', status: 409 },
  { seats: [99], discountStatus: 'approved', status: 400 },
]) test(`checkout rejects ineligible seats ${scenario.seats} (${scenario.discountStatus}) before charging`, async () => {
  const h = checkoutHarness(scenario); const res = response(); const req = request(); req.body.seats = scenario.seats;
  await h.handler(req, res);
  assert.equal(res.code, scenario.status); assert.equal(h.inserts.length, 0); assert.equal(h.charges.length, 0);
});
test('checkout accepts one matching exclusive seat with regular companions', async () => {
  const h = checkoutHarness(); const res = response(); const req = request(); req.body.seats = [5, 9];
  await h.handler(req, res); assert.equal(res.code, 200); assert.equal(h.charges.length, 1);
});
test('checkout rejects forged passenger ID before any booking or payment', async () => {
  const h = checkoutHarness(); const res = response(); const req = request(); req.body.userId = 'someone-else';
  await h.handler(req, res); assert.equal(res.code, 403); assert.equal(h.inserts.length, 0); assert.equal(h.charges.length, 0);
});
