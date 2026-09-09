// Get notifications for a specific client by user id
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const Stripe = require('stripe');
const crypto = require('crypto');
const sgMail = process.env.SENDGRID_API_KEY ? require('@sendgrid/mail') : null;

const app = express();


// Calculate a rough ETA from a bus position to the route's end terminal.
// Browser geolocation commonly reports no speed, so use a conservative city
// driving-speed estimate in that case instead of hiding a usable ETA.
function calculateBusEta(currentLocation, targetLocation, speedMetersPerSecond) {
  if (!currentLocation || !targetLocation) return null;
  const FALLBACK_SPEED_METERS_PER_SECOND = 25 / 3.6; // 25 km/h
  const travelSpeed = typeof speedMetersPerSecond === 'number' &&
    Number.isFinite(speedMetersPerSecond) &&
    speedMetersPerSecond > 0.5
    ? speedMetersPerSecond
    : FALLBACK_SPEED_METERS_PER_SECOND;

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(targetLocation.lat - currentLocation.lat);
  const dLng = toRadians(targetLocation.lng - currentLocation.lng);
  const lat1 = toRadians(currentLocation.lat);
  const lat2 = toRadians(targetLocation.lat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const distanceMeters = 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const minutes = Math.max(1, Math.round(distanceMeters / travelSpeed / 60));
  return `${minutes} mins`;
}

function normalizeLatLng(value) {
  if (value == null) return null;
  let loc = value;
  if (typeof loc === 'string') {
    try {
      loc = JSON.parse(loc);
    } catch {
      return null;
    }
  }
  if (typeof loc !== 'object' || loc === null) return null;
  const latRaw = loc.lat ?? loc.latitude;
  const lngRaw = loc.lng ?? loc.longitude ?? loc.lon;
  const lat = typeof latRaw === 'number' ? latRaw : parseFloat(latRaw);
  const lng = typeof lngRaw === 'number' ? lngRaw : parseFloat(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function broadcastLiveLocation(payload) {
  const message = `data: ${JSON.stringify({ type: 'location_update', data: payload })}\n\n`;
  for (const client of liveLocationClients) {
    client.write(message);
  }
}

// Initialize Stripe and SendGrid if keys are present
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' }) : null;

// Startup diagnostics for Stripe configuration (safe, masked output)
try {
  const hasStripeKey = Boolean(process.env.STRIPE_SECRET_KEY);
  const hasWebhookSecret = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  if (!hasStripeKey) {
    console.warn('⚠️  Stripe secret key not found in environment (STRIPE_SECRET_KEY). Stripe will be disabled.');
  } else {
    const masked = process.env.STRIPE_SECRET_KEY.replace(/.(?=.{4})/g, '*');
    console.debug(`🔒 STRIPE_SECRET_KEY present: ${masked}`);
  }
  if (!hasWebhookSecret) {
    console.warn('⚠️  Stripe webhook secret (STRIPE_WEBHOOK_SECRET) not configured. Webhook signature verification will fail if used.');
  } else {
    const maskedHook = process.env.STRIPE_WEBHOOK_SECRET.replace(/.(?=.{4})/g, '*');
    console.debug(`🔐 STRIPE_WEBHOOK_SECRET present: ${maskedHook}`);
  }
  if (!stripe) {
    console.warn('ℹ️  Stripe client not initialized. Calls to payment endpoints will return "Stripe is not configured".');
  } else {
    console.log('✅ Stripe client initialized.');
  }
} catch (diagErr) {
  console.error('Error while checking Stripe environment variables:', diagErr);
}

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
if (sgMail) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const passwordOtpStore = new Map();
const latestLocationsByBusId = new Map();
const liveLocationClients = new Set();

const seatReadClient = supabaseAdmin || supabase;

// `available_seats` is derived state. Never adjust it with +/- counters: that
// drifts when a booking is confirmed, cancelled, or changed by an employee.
async function syncBusAvailability(busId) {
  const [{ data: bus, error: busError }, { data: bookings, error: bookingsError }] = await Promise.all([
    supabase.from('buses').select('id, total_seats, standing_capacity').eq('id', busId).single(),
    supabase
      .from('bookings')
      .select('status, seats, booking_type, seat_assignment, standing_count')
      .eq('bus_id', busId)
      .in('status', ['pending', 'confirmed', 'boarded']),
  ]);
  if (busError) throw busError;
  if (bookingsError) throw bookingsError;

  const occupied = (bookings || []).reduce((count, booking) => {
    const type = booking.booking_type || 'regular';
    if (type === 'pickup_request') {
      return count + (booking.seat_assignment === 'seat' && Array.isArray(booking.seats)
        ? booking.seats.length
        : 0);
    }
    return count + (Array.isArray(booking.seats) ? booking.seats.length : 0);
  }, 0);
  const occupiedStanding = (bookings || []).reduce((count, booking) => {
    const isStanding = booking.booking_type === 'regular'
      ? booking.seat_assignment === 'standing'
      : booking.seat_assignment === 'standing';
    return count + (isStanding ? Math.max(1, Number(booking.standing_count || 0)) : 0);
  }, 0);
  const available_seats = Math.max(0, Number(bus.total_seats || 0) - occupied);
  const available_standing = Math.max(0, Number(bus.standing_capacity || 0) - occupiedStanding);
  const { data: updated, error: updateError } = await supabase
    .from('buses')
    .update({ available_seats, available_standing })
    .eq('id', busId)
    .select()
    .single();
  if (updateError) throw updateError;
  return updated;
}

async function expireStaleBookings() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { error } = await supabase
    .from('bookings')
    .update({ status: 'no_show' })
    .in('status', ['pending', 'confirmed'])
    .lt('travel_date', todayStart.toISOString());

  if (error) console.warn('Could not expire stale bookings:', error.message);
}

async function findSeatConflicts(busId, travelDate, seatList) {
  if (!busId || !travelDate || !Array.isArray(seatList) || seatList.length === 0) {
    return [];
  }

  const day = new Date(travelDate);
  if (Number.isNaN(day.getTime())) {
    const { data, error } = await seatReadClient
      .from('bookings')
      .select('seats')
      .eq('bus_id', busId)
      .eq('travel_date', travelDate)
      .in('status', ['pending', 'confirmed', 'boarded']);
    if (error) throw error;
    const taken = new Set();
    (data || []).forEach((b) => (b.seats || []).forEach((s) => taken.add(String(s))));
    return seatList.filter((s) => taken.has(String(s)));
  }

  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const { data, error } = await seatReadClient
    .from('bookings')
    .select('seats')
    .eq('bus_id', busId)
    .in('status', ['pending', 'confirmed', 'boarded'])
    .gte('travel_date', dayStart.toISOString())
    .lt('travel_date', dayEnd.toISOString());

  if (error) throw error;

  const taken = new Set();
  (data || []).forEach((b) => (b.seats || []).forEach((s) => taken.add(String(s))));
  return seatList.filter((s) => taken.has(String(s)));
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Middleware
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook' || req.originalUrl === '/api/webhook') return next();
  return express.json({ limit: '10mb' })(req, res, next);
});

// Ensure oversized JSON bodies return JSON, not HTML
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  next(err);
});

// For Stripe webhook handling
app.use('/webhook', express.raw({ type: 'application/json' }));

app.get(['/health', '/api/health'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    status: 'healthy',
    service: 'bus-tracking-backend',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/create-payment-session', async (req, res) => {
  return res.status(410).json({
    error: 'This endpoint is deprecated. Use /api/client/create-payment-session instead.',
  });
});

app.post('/__disabled/api/create-payment-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  try {
    const { userId, busId, seats, routeName, date } = req.body;
    const seatCount = Array.isArray(seats) && seats.length ? seats.length : 1;
    const { data: fareBus, error: fareBusError } = await supabase
      .from('buses')
      .select('route:routes(fare_per_seat)')
      .eq('id', busId)
      .single();
    if (fareBusError || !fareBus) {
      return res.status(400).json({ error: 'Invalid busId' });
    }
    const totalPrice = Number((Number(fareBus.route?.fare_per_seat ?? 15) * seatCount).toFixed(2));

    // Create a pending booking in the database
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert([{
        user_id: userId,
        bus_id: busId,
        seats: seats,
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'online',
        amount: totalPrice,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (bookingError) throw bookingError;

    // Create Stripe checkout session
    const origin =
      process.env.FRONTEND_URL ||
      process.env.VITE_FRONTEND_URL ||
      req.headers.origin ||
      (req.get('referer') ? new URL(req.get('referer')).origin : 'https://auroride.xyz');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'php',
          product_data: {
            name: `Bus Booking - ${routeName}`,
            description: `${seats.length} seat(s) for ${date}`,
          },
          unit_amount: Math.round(totalPrice * 100), // Stripe expects amounts in centavos for PHP
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${origin}/booking-success?bookingId=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/booking?bookingId=${booking.id}`,
      metadata: {
        booking_id: booking.id,
        user_id: userId,
        seats: seats.join(','),
        route_name: routeName,
        date: date
      }
    });

    // Update booking with session ID
    await supabase
      .from('bookings')
      .update({ payment_intent_id: session.payment_intent })
      .eq('id', booking.id);

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Payment session creation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle Stripe webhook
app.post('/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      // Update booking status
      const { error: updateError } = await supabase
        .from('bookings')
        .update({ 
          payment_status: 'paid',
          payment_intent_id: session.payment_intent,
          updated_at: new Date().toISOString()
        })
        .eq('id', session.metadata.booking_id);

      if (updateError) throw updateError;

      // Send receipt email
      await sendReceiptEmail({
        to: session.customer_email,
        booking: {
          id: session.metadata.booking_id,
          payment_intent_id: session.payment_intent
        },
        totalPrice: session.amount_total / 100,
        seats: session.metadata.seats.split(','),
        routeName: session.metadata.route_name,
        date: session.metadata.date
      });
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing failed:', error);
    res.status(500).json({ error: error.message });
  }
});

const sendReceiptEmail = async ({ to, booking, totalPrice, seats, routeName, date }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return false;
  const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || 'http://localhost:5173';
  const logoUrl = "https://ysxcngthzeajjrxwqgvq.supabase.co/storage/v1/object/public/Public/AuroRide.jpg";
  const safeSeats = Array.isArray(seats) ? seats.join(', ') : (seats || 'N/A');
  const safeRoute = routeName || 'N/A';
  const safeDate = date ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
  const phpNum = typeof totalPrice === 'number' ? totalPrice : Number(totalPrice || 0);
  const safeTotal = `₱${phpNum.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const html = `
  <div style="background-color:#f6f7fb;padding:24px 0;margin:0;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:0 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8ef;">
            <tr>
              <td style="background:linear-gradient(90deg,#f472b6,#fb7185);padding:24px;" align="center">
                <img src="${logoUrl}" alt="AuroRide" width="88" height="88" style="border-radius:12px;display:block;border:2px solid rgba(255,255,255,0.6);" />
                <div style="height:12px"></div>
                <div style="font-size:20px;color:#fff;font-weight:700;letter-spacing:0.3px;">AuroRide Booking Receipt</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <div style="font-size:16px;color:#111827;font-weight:700;margin-bottom:12px;">Thank you for your booking!</div>
                <div style="font-size:13px;color:#6b7280;line-height:1.6;margin-bottom:16px;">
                  Below are the details of your reservation. Keep this email as your proof of purchase.
                </div>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e6e8ef;border-radius:10px;overflow:hidden;">
                  <tr style="background-color:#f9fafb;">
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Booking ID</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${booking.id}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Route</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${safeRoute}</td>
                  </tr>
                  <tr style="background-color:#f9fafb;">
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Date</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${safeDate}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Seats</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${safeSeats}</td>
                  </tr>
                  <tr style="background-color:#f9fafb;">
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Total Paid</td>
                    <td style="padding:12px 16px;">
                      <div style="font-size:14px;color:#db2777;font-weight:700;margin-bottom:2px;">${safeTotal}</div>
                    </td>
                  </tr>
                </table>
                <div style="height:16px"></div>
                <a href="${frontendUrl}/booking?bookingId=${booking.id}" style="display:inline-block;background:#f472b6;color:#fff;text-decoration:none;font-size:13px;font-weight:700;border-radius:8px;padding:10px 16px;">
                  View Booking
                </a>
                <div style="height:20px"></div>
                <div style="font-size:12px;color:#6b7280;line-height:1.6;">
                  If you have questions, reply to this email or contact our support.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;border-top:1px solid #e6e8ef;background-color:#fcfcfd;" align="center">
                <div style="font-size:11px;color:#9ca3af;">© ${new Date().getFullYear()} AuroRide. All rights reserved.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
  `;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: "team@auroride.xyz" || 'no-reply@auroride.com',
        to: [to],
        subject: `AuroRide Booking Receipt — ${booking.id}`,
        html,
      }),
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        console.error('Resend email error', errBody);
      } catch (_) {}
      return false;
    }
    return true;
  } catch (err) {
    console.error('Resend request failed', err);
    return false;
  }
};

const sendConfirmationEmail = async ({ to, booking, routeName, date }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return false;
  const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || 'http://localhost:5173';
  const logoUrl = "https://ysxcngthzeajjrxwqgvq.supabase.co/storage/v1/object/public/Public/AuroRide.jpg";
  const safeRoute = routeName || 'N/A';
  const safeDate = date ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
  const html = `
  <div style="background-color:#f6f7fb;padding:24px 0;margin:0;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:0 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8ef;">
            <tr>
              <td style="background:linear-gradient(90deg,#22c55e,#16a34a);padding:24px;" align="center">
                <img src="${logoUrl}" alt="AuroRide" width="88" height="88" style="border-radius:12px;display:block;border:2px solid rgba(255,255,255,0.6);" />
                <div style="height:12px"></div>
                <div style="font-size:20px;color:#fff;font-weight:700;letter-spacing:0.3px;">Booking Confirmed</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <div style="font-size:16px;color:#111827;font-weight:700;margin-bottom:12px;">Your reservation is confirmed</div>
                <div style="font-size:13px;color:#6b7280;line-height:1.6;margin-bottom:16px;">
                  We’ve confirmed your booking. Here are the key details.
                </div>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e6e8ef;border-radius:10px;overflow:hidden;">
                  <tr style="background-color:#f9fafb;">
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Booking ID</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${booking.id}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Route</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${safeRoute}</td>
                  </tr>
                  <tr style="background-color:#f9fafb;">
                    <td style="padding:12px 16px;font-size:12px;color:#6b7280;width:35%;">Date</td>
                    <td style="padding:12px 16px;font-size:12px;color:#111827;font-weight:600;">${safeDate}</td>
                  </tr>
                </table>
                <div style="height:16px"></div>
                <a href="${frontendUrl}/booking?bookingId=${booking.id}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-size:13px;font-weight:700;border-radius:8px;padding:10px 16px;">
                  View Booking
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;border-top:1px solid #e6e8ef;background-color:#fcfcfd;" align="center">
                <div style="font-size:11px;color:#9ca3af;">© ${new Date().getFullYear()} AuroRide. All rights reserved.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
  `;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: "team@auroride.xyz" || 'no-reply@auroride.com',
        to: [to],
        subject: `AuroRide Booking Confirmed — ${booking.id}`,
        html,
      }),
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        console.error('Resend confirmation email error', errBody);
      } catch (_) {}
      return false;
    }
    return true;
  } catch (err) {
    console.error('Resend confirmation request failed', err);
    return false;
  }
};
app.post('/api/client/booking/:id/send-receipt', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Booking not paid' });
    }
    const to = booking.email;
    const totalPrice = booking.amount;
    const seats = booking.seats || [];
    let routeName = booking.route_name || null;
    if (!routeName && booking.bus_id) {
      try {
        const { data: busRow } = await supabase
          .from('buses')
          .select('route_id')
          .eq('id', booking.bus_id)
          .single();
        const routeId = busRow?.route_id || null;
        if (routeId) {
          const { data: routeRow } = await supabase
            .from('routes')
            .select('name')
            .eq('id', routeId)
            .single();
          routeName = routeRow?.name || null;
        }
      } catch (_) {}
    }
    const date = booking.travel_date || null;
    const sent = await sendReceiptEmail({ to, booking, totalPrice, seats, routeName, date });
    if (sent) {
      await supabase
        .from('bookings')
        .update({ receipt_sent: true })
        .eq('id', id);
      return res.json({ success: true });
    } else {
      console.error('Receipt email failed to send for booking:', id);
      return res.json({ success: true, email_failed: true, error: 'Failed to send receipt' });
    }
  } catch (err) {
    return res.status(500).json({ error: err && err.message ? err.message : 'Unexpected error' });
  }
});

// Confirm Stripe payment by session_id and send receipt (for success page flow)
app.post('/api/client/booking/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id } = req.body || {};
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured on server.' });
    }
    if (!session_id || typeof session_id !== 'string') {
      return res.status(400).json({ error: 'session_id is required' });
    }
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session) {
      return res.status(404).json({ error: 'Stripe session not found' });
    }
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(400).json({ error: 'Payment not completed' });
    }
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.payment_status !== 'paid') {
      await supabase
        .from('bookings')
        .update({ payment_status: 'paid', payment_intent_id: session.payment_intent || null })
        .eq('id', id);
    }
    // If receipt already sent, return success
    if (booking.receipt_sent) {
      return res.json({ success: true, message: 'Receipt already sent' });
    }
    const to = booking.email || session.customer_details?.email || session.customer_email;
    const totalPrice = booking.amount;
    const seats = booking.seats || [];
    let routeName = session.metadata?.route_name || booking.route_name || null;
    if (!routeName && booking.bus_id) {
      try {
        const { data: busRow } = await supabase
          .from('buses')
          .select('route_id')
          .eq('id', booking.bus_id)
          .single();
        const routeId = busRow?.route_id || null;
        if (routeId) {
          const { data: routeRow } = await supabase
            .from('routes')
            .select('name')
            .eq('id', routeId)
            .single();
          routeName = routeRow?.name || null;
        }
      } catch (_) {}
    }
    const date = booking.travel_date || null;
    const sent = await sendReceiptEmail({ to, booking, totalPrice, seats, routeName, date });
    if (sent) {
      await supabase
        .from('bookings')
        .update({ receipt_sent: true })
        .eq('id', id);
      return res.json({ success: true, message: 'Receipt sent' });
    } else {
      console.error('Receipt email failed to send after payment confirmation:', id);
      return res.json({ success: true, email_failed: true, message: 'Payment confirmed; email failed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err && err.message ? err.message : 'Unexpected error' });
  }
});


// Enhanced Supabase real-time subscriptions for notifications
const notificationChannels = new Map();
const sseClientsByUser = new Map(); // userId -> Set<res>

// Broadcast helper to push events to all SSE clients for a given user
const broadcastToUser = (userId, event) => {
  const clients = sseClientsByUser.get(String(userId));
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(event);
  clients.forEach((res) => {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      // Drop broken clients silently
    }
  });
};

// Function to create notification channel for a specific user
const createNotificationChannel = (userId) => {
  if (notificationChannels.has(userId)) {
    return notificationChannels.get(userId);
  }

  const channel = supabase
    .channel(`notifications_${userId}`)
    .on('postgres_changes', 
      { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      }, 
      (payload) => {
        // New notification for this user
        broadcastToUser(userId, { type: 'notification.insert', data: payload.new });
      }
    )
    .on('postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      },
      (payload) => {
        broadcastToUser(userId, { type: 'notification.update', data: payload.new, old: payload.old });
      }
    )
    .on('postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      },
      (payload) => {
        broadcastToUser(userId, { type: 'notification.delete', data: payload.old });
      }
    )
    .subscribe();

  notificationChannels.set(userId, channel);
  return channel;
};

// Cleanup function for notification channels
const cleanupNotificationChannel = (userId) => {
  if (notificationChannels.has(userId)) {
    const channel = notificationChannels.get(userId);
    channel.unsubscribe();
    notificationChannels.delete(userId);
    console.log(`🧹 Cleaned up notification channel for user ${userId}`);
  }
};


app.put('/api/employee/booking/:id/mark-paid', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body || {};

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .select('id, bus_id, payment_method, payment_status, status')
      .eq('id', id)
      .single();

    if (bookingErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.payment_method !== 'cash') {
      return res.status(400).json({ error: 'Only cash bookings can be marked paid this way' });
    }

    if (booking.payment_status === 'paid') {
      return res.json({ message: 'Already marked as paid', booking });
    }
    const { data: bus, error: busErr } = await supabase
      .from('buses')
      .select('id, driver_id, conductor_id')
      .eq('id', booking.bus_id)
      .single();

    if (busErr || !bus) {
      return res.status(404).json({ error: 'Bus not found for this booking' });
    }

    const isAssigned = bus.driver_id === employeeId || bus.conductor_id === employeeId;
    if (!isAssigned) {
      return res.status(403).json({ error: 'You are not assigned to this bus' });
    }
    const { data: updated, error: updateErr } = await supabase
      .from('bookings')
      .update({
        payment_status: 'paid',
        payment_confirmed_by: employeeId,
        payment_confirmed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.json({ message: 'Marked as paid', booking: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/employee/booking/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId, status } = req.body || {};
    const allowedStatuses = ['boarded', 'completed', 'no_show'];

    if (!employeeId || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Employee ID and a valid booking status are required' });
    }

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id, bus_id, status, booking_type, seat_assignment, payment_status')
      .eq('id', id)
      .single();
    if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });

    const { data: bus, error: busError } = await supabase
      .from('buses')
      .select('id, driver_id, conductor_id')
      .eq('id', booking.bus_id)
      .single();
    if (busError || !bus) return res.status(404).json({ error: 'Bus not found for this booking' });
    if (bus.driver_id !== employeeId && bus.conductor_id !== employeeId) {
      return res.status(403).json({ error: 'You are not assigned to this bus' });
    }

    const validTransition =
      (status === 'boarded' && ['pending', 'confirmed'].includes(booking.status)) ||
      (status === 'completed' && booking.status === 'boarded') ||
      (status === 'no_show' && ['pending', 'confirmed'].includes(booking.status));
    if (!validTransition) {
      return res.status(409).json({ error: `Cannot change booking from ${booking.status} to ${status}` });
    }
    if (status === 'boarded' && booking.booking_type === 'regular' && booking.payment_status !== 'paid') {
      return res.status(409).json({ error: 'Regular bookings must be paid before boarding' });
    }
    if (status === 'boarded' && booking.booking_type === 'pickup_request' && !['seat', 'standing'].includes(booking.seat_assignment)) {
      return res.status(409).json({ error: 'Assign a seat or standing status before boarding this pickup request' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('bookings')
      .update({ status })
      .eq('id', id)
      .select(`*, bus:bus_id(bus_number, route:route_id(name)), user:user_id(username, email, profile)`)
      .single();
    if (updateError) throw updateError;
    await syncBusAvailability(booking.bus_id);

    res.json({ message: `Booking marked ${status}`, booking: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




// Server-Sent Events (SSE) endpoint for real-time notifications per user
app.get('/api/rt/notifications/:userId', (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Register client
  if (!sseClientsByUser.has(String(userId))) {
    sseClientsByUser.set(String(userId), new Set());
  }
  const clientSet = sseClientsByUser.get(String(userId));
  clientSet.add(res);

  // Ensure a channel exists for this user
  createNotificationChannel(userId);

  // Send an initial event for readiness
  res.write(`data: ${JSON.stringify({ type: 'ready', userId })}\n\n`);

  // Heartbeat to keep the connection alive behind proxies/LB
  const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 25000);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, HEARTBEAT_MS);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClientsByUser.get(String(userId));
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        sseClientsByUser.delete(String(userId));
        // Optionally release Supabase channel to free resources
        cleanupNotificationChannel(userId);
      }
    }
    try { res.end(); } catch (_) {}
  });
});


app.get('/api/buses/:busId/booked-seats', async (req, res) => {
  try {
    const { busId } = req.params;
    const { date } = req.query;
    if (!busId || !date) {
      return res.status(400).json({ error: 'busId and date are required' });
    }

    const day = new Date(date);
    if (Number.isNaN(day.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const { data, error } = await seatReadClient
      .from('bookings')
      .select('seats')
      .eq('bus_id', busId)
      .in('status', ['pending', 'confirmed', 'boarded'])
      .gte('travel_date', dayStart.toISOString())
      .lt('travel_date', dayEnd.toISOString());

    if (error) throw error;

    const takenSeats = Array.from(
      new Set((data || []).flatMap((b) => (b.seats || []).map((s) => Number(s))))
    ).sort((a, b) => a - b);

    res.json({ bookedSeats: takenSeats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/client/booking', async (req, res) => {
  try {
    const {
      userId,
      busId,
      seats,
      seat_number,
      travel_date,
      date,
      email,
      payment_method,
      pickup_address,
      pickup_lat,
      pickup_lng,
      pickup_location_source,
      seat_assignment,
      standing_count,
    } = req.body;

    const isStanding = seat_assignment === 'standing';

    const seatList = Array.isArray(seats) && seats.length
      ? seats
      : seat_number != null
        ? [seat_number]
        : [];

    if (!busId) {
      return res.status(400).json({ error: 'busId is required' });
    }
    if (!isStanding && seatList.length === 0) {
      return res.status(400).json({ error: 'At least one seat is required' });
    }
    if (isStanding && seatList.length > 0) {
      return res.status(400).json({ error: 'A standing booking cannot include seat numbers' });
    }
    const standingCount = isStanding ? Number(standing_count || 1) : 0;
    if (!Number.isInteger(standingCount) || standingCount < 1 || standingCount > 4) {
      return res.status(400).json({ error: 'standing_count must be between 1 and 4' });
    }

    const isValidUUID = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
    const resolvedUserId = isValidUUID(userId) ? userId : null;
    if (resolvedUserId) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('id', resolvedUserId)
        .single();
      if (!existingUser) {
        const userEmail = email || req.body.email || '';
        const username = userEmail ? userEmail.split('@')[0] : 'user';
        await supabase
          .from('users')
          .insert({ id: resolvedUserId, email: userEmail, username, role: 'client', profile: {} });
      }
    }

    const travelDate = travel_date || date || null;

    const { data: busForFare, error: busForFareError } = await supabase
      .from('buses')
      .select('route_id, available_seats, available_standing, route:routes(fare_per_seat)')
      .eq('id', busId)
      .single();
    if (busForFareError || !busForFare) {
      return res.status(400).json({ error: 'Invalid busId' });
    }

    let discountMultiplier = 1.0;
    if (resolvedUserId) {
      const { data: discount } = await supabase
        .from('discount_verifications')
        .select('status')
        .eq('user_id', resolvedUserId)
        .eq('status', 'approved')
        .maybeSingle();

      if (discount) {
        discountMultiplier = 0.8;
      }
    }

    const farePerSeat = Number(busForFare.route?.fare_per_seat ?? 15);
    const passengerCount = isStanding ? standingCount : seatList.length;
    const resolvedAmount = Number((farePerSeat * passengerCount * discountMultiplier).toFixed(2));

    // Prevent double-booking: reject if any requested seat is already
    // held by another non-cancelled booking for this bus + date.
    const seatConflicts = isStanding ? [] : await findSeatConflicts(busId, travelDate, seatList);
    if (seatConflicts.length > 0) {
      return res.status(409).json({
        error: `Seat(s) already taken: ${seatConflicts.join(', ')}. Please choose different seat(s).`,
        conflictingSeats: seatConflicts,
      });
    }
    const refreshedBus = await syncBusAvailability(busId);
    if (isStanding && Number(refreshedBus.available_standing || 0) < standingCount) {
      return res.status(409).json({ error: 'No standing slots are available on this bus.' });
    }
    if (!isStanding && Number(refreshedBus.available_seats || 0) < seatList.length) {
      return res.status(409).json({ error: 'Not enough seats are available. You may book as standing if standing slots remain.' });
    }

    const pickupPayload =
      pickup_lat != null &&
      pickup_lng != null &&
      Number.isFinite(Number(pickup_lat)) &&
      Number.isFinite(Number(pickup_lng))
        ? {
            pickup_address: pickup_address || null,
            pickup_lat: Number(pickup_lat),
            pickup_lng: Number(pickup_lng),
            pickup_location_source: pickup_location_source || 'search',
          }
        : {};

    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({
        user_id: resolvedUserId,
        bus_id: busId,
        status: 'pending',
        payment_method: payment_method || 'cash',
        payment_status: 'pending',
        booking_type: 'regular',
        seat_assignment: isStanding ? 'standing' : 'reserved',
        seats: isStanding ? [] : seatList,
        standing_count: standingCount,
        travel_date: travelDate,
        amount: resolvedAmount,
        email: email || null,
        ...pickupPayload,
      })
      .select()
      .single();

    if (error) throw error;
    await syncBusAvailability(busId);

    res.status(201).json(booking);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save / update passenger pickup location on a booking
app.patch('/api/client/booking/:id/pickup', async (req, res) => {
  try {
    const { id } = req.params;
    const { pickup_address, pickup_lat, pickup_lng, pickup_location_source, userId } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: 'Booking id is required' });
    }

    const lat = pickup_lat != null ? Number(pickup_lat) : NaN;
    const lng = pickup_lng != null ? Number(pickup_lng) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Valid pickup_lat and pickup_lng are required' });
    }

    const allowedSources = ['gps', 'search', 'manual', 'approximate'];
    const source = allowedSources.includes(pickup_location_source)
      ? pickup_location_source
      : 'manual';

    let updateQuery = supabase
      .from('bookings')
      .update({
        pickup_address: pickup_address || null,
        pickup_lat: lat,
        pickup_lng: lng,
        pickup_location_source: source,
      })
      .eq('id', id);

    if (userId) {
      updateQuery = updateQuery.eq('user_id', userId);
    }

    const { data, error } = await updateQuery.select().single();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a Stripe Checkout session and a pending booking (online payment)
app.post('/api/client/create-payment-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured on server.' });

    const { userId, email, busId, seats = [], date, seat_assignment, standing_count } = req.body;
    if (!userId || !busId || !email) return res.status(400).json({ error: 'userId, email and busId are required' });
    const isStanding = seat_assignment === 'standing';
    const standingCount = isStanding ? Number(standing_count || 1) : 0;
    if (isStanding && (!Number.isInteger(standingCount) || standingCount < 1 || standingCount > 4)) {
      return res.status(400).json({ error: 'standing_count must be between 1 and 4' });
    }
    if ((!isStanding && (!Array.isArray(seats) || seats.length === 0)) || (isStanding && seats.length > 0)) {
      return res.status(400).json({ error: isStanding ? 'A standing booking cannot include seat numbers' : 'At least one seat is required' });
    }

    const isValidUUID = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
    const resolvedUserId = isValidUUID(userId) ? userId : null;

    if (resolvedUserId) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('id', resolvedUserId)
        .single();
      if (!existingUser) {
        await supabase
          .from('users')
          .insert({ id: resolvedUserId, email, username: email.split('@')[0], role: 'client', profile: {} });
      }
    }

    // Resolve route name and fare from bus -> routes
    let resolvedRouteName = null;
    let farePerSeat = 15;
    try {
      const { data: busRow } = await supabase
        .from('buses')
        .select('route_id')
        .eq('id', busId)
        .single();
      const routeId = busRow?.route_id || null;
      if (routeId) {
        const { data: routeRow } = await supabase
          .from('routes')
          .select('name, fare_per_seat')
          .eq('id', routeId)
          .single();
        resolvedRouteName = routeRow?.name || null;
        farePerSeat = Number(routeRow?.fare_per_seat ?? 15);
      }
    } catch (_) {
      // best-effort only
    }

    // Check for approved discount
    let discountMultiplier = 1.0;
    if (resolvedUserId) {
      const { data: discount } = await supabase
        .from('discount_verifications')
        .select('status')
        .eq('user_id', resolvedUserId)
        .eq('status', 'approved')
        .maybeSingle();
      
      if (discount) {
        discountMultiplier = 0.8; // 20% discount
      }
    }

    // Calculate amount with discount
    const seatCount = isStanding ? standingCount : seats.length;
    const finalAmount = Number((farePerSeat * seatCount * discountMultiplier).toFixed(2));

    // Prevent double-booking, same as the cash-payment endpoint.
    const seatConflicts = isStanding ? [] : await findSeatConflicts(busId, date, seats || []);
    if (seatConflicts.length > 0) {
      return res.status(409).json({
        error: `Seat(s) already taken: ${seatConflicts.join(', ')}. Please choose different seat(s).`,
        conflictingSeats: seatConflicts,
      });
    }
    const refreshedBus = await syncBusAvailability(busId);
    if (isStanding && Number(refreshedBus.available_standing || 0) < standingCount) {
      return res.status(409).json({ error: 'No standing slots are available on this bus.' });
    }
    if (!isStanding && Number(refreshedBus.available_seats || 0) < seats.length) {
      return res.status(409).json({ error: 'Not enough seats are available. You may book as standing if standing slots remain.' });
    }

    // Create booking with pending payment
    const bookingPayload = {
      user_id: resolvedUserId,
      bus_id: busId,
      status: 'pending',
      payment_method: 'online',
      payment_status: 'pending',
      booking_type: 'regular',
      seat_assignment: isStanding ? 'standing' : 'reserved',
      seats: isStanding ? [] : seats,
      standing_count: standingCount,
      travel_date: date || null,
      amount: finalAmount,
      email: email,
    };

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .insert(bookingPayload)
      .select()
      .single();

    if (bookingErr) throw bookingErr;
    await syncBusAvailability(busId);

    const lineAmount = Math.round(finalAmount * 100); // total in cents

    const origin =
      process.env.FRONTEND_URL ||
      req.headers.origin ||
      (req.get('referer') ? new URL(req.get('referer')).origin : 'https://auroride.xyz');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'php',
            product_data: { 
              name: `AuroRide — ${resolvedRouteName || booking.id}`,
              description: `${seatCount} seat(s) for ${date || 'selected date'}`
            },
            unit_amount: lineAmount,
          },
          quantity: 1, // charge the total once
        }
      ],
      customer_email: email,
      metadata: { 
        bookingId: booking.id, 
        route_name: resolvedRouteName || '', 
        seats: (seats || []).join(','),
        date: date || ''
      },
      success_url: `${origin}/booking-success?bookingId=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/booking?bookingId=${booking.id}`,
    });

    // Store session id on booking for webhook correlation
    await supabase
      .from('bookings')
      .update({ checkout_session_id: session.id, payment_intent_id: session.payment_intent || null })
      .eq('id', booking.id);

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('create-payment-session error', error);
    res.status(500).json({ error: error.message || 'Failed to create payment session' });
  }
});

// Stripe webhook endpoint
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    return res.status(500).send('Stripe webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;

    if (bookingId) {
      try {
        // Get booking record
        const { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('id', bookingId)
          .single();

        if (booking && booking.payment_status !== 'paid') {
          await supabase
            .from('bookings')
            .update({ payment_status: 'paid', payment_intent_id: session.payment_intent || null })
            .eq('id', bookingId);
        }
        try {
          let routeName = session.metadata?.route_name || booking.route_name || null;
          if (!routeName && booking.bus_id) {
            try {
              const { data: busRow } = await supabase
                .from('buses')
                .select('route_id')
                .eq('id', booking.bus_id)
                .single();
              const routeId = busRow?.route_id || null;
              if (routeId) {
                const { data: routeRow } = await supabase
                  .from('routes')
                  .select('name')
                  .eq('id', routeId)
                  .single();
                routeName = routeRow?.name || null;
              }
            } catch (_) {}
          }
          await sendReceiptEmail({
            to: booking.email || session.customer_details?.email,
            booking,
            totalPrice: booking.amount,
            seats: booking.seats || [],
            routeName,
            date: booking.travel_date || null
          });
          await supabase
            .from('bookings')
            .update({ receipt_sent: true })
            .eq('id', bookingId);
        } catch (emailErr) {
          console.warn('Failed to send receipt email:', emailErr.message || emailErr);
        }
      } catch (err) {
        console.error('Failed to process checkout.session.completed:', err);
      }
    }
  }

  res.json({ received: true });
});

// Cancel a client's booking (soft delete via status)
app.delete('/api/client/booking/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .select('id, user_id, bus_id, status')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (bookingErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.json({ message: 'Booking already cancelled' });
    }

    // Set status to cancelled
    const { error: updateErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (updateErr) throw updateErr;

    await syncBusAvailability(booking.bus_id);

    res.json({ message: 'Booking cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/bookings', async (req, res) => {
  try {
    await expireStaleBookings();
    const { userId } = req.query;
    let query = supabase
      .from('bookings')
      .select(`
        id, user_id, bus_id, status, payment_method, payment_status, booking_type, seat_assignment, seats, amount, travel_date, created_at, receipt_sent,
        pickup_address, pickup_lat, pickup_lng, pickup_location_source,
        bus:bus_id(bus_number, route:route_id(name)),
        user:user_id(username, email, profile)
      `)
      .order('created_at', { ascending: false });
    if (userId) {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/client/feedback', async (req, res) => {
  try {
    const { user_id, bus_id, rating, comment } = req.body;
    const { data: feedback, error } = await supabase
      .from('feedbacks')
      .insert({ user_id, bus_id, rating, comment })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(feedback);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/feedback', async (req, res) => {
  try {
    const { userId } = req.query;
    let query = supabase
      .from('feedbacks')
      .select(`
        id, rating, comment, created_at, user_id, bus_id,
        user:user_id(username, email, profile),
        bus:bus_id(bus_number, route:route_id(name))
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/feedback/user', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id, rating, comment, created_at, bus_id,
        bus:bus_id(bus_number, route:route_id(name))
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete client's feedback
app.delete('/api/client/feedback/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Ensure feedback belongs to the user
    const { data: feedback, error: fbErr } = await supabase
      .from('feedbacks')
      .select('id, user_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fbErr || !feedback) {
      return res.status(404).json({ error: 'Feedback not found or access denied' });
    }

    const { error } = await supabase
      .from('feedbacks')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Feedback deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/client/contact', async (req, res) => {
  try {
    const { fullName, email, message } = req.body;
    if (!fullName || !email || !message) {
      return res.status(400).json({ error: 'fullName, email, and message are required' });
    }

    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({ full_name: fullName, email, message, status: 'new' })
      .select('id, full_name, email, message, status, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(contact);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Routes

app.get('/api/admin/transit-insights', async (req, res) => {
  try {
    const { data: buses, error } = await supabase
      .from('buses')
      .select('*, driver:driver_id(id, username, profile), conductor:conductor_id(id, username, profile)')
      .eq('status', 'active');

    if (error) throw error;
    // Add real-time analytics logic here
    res.json(buses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm a booking and send notifications
app.put('/api/admin/booking/:id/confirm', async (req, res) => {
  try {
    // 1. Confirm the booking
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', req.params.id)
      .select(`
        *,
        bus:bus_id(*, route:route_id(name)),
        user:user_id(*)
      `)
      .single();

    if (bookingError) throw bookingError;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // 2. Prepare notification details
    const { bus, user } = booking;
    const driverId = bus.driver_id;
    const conductorId = bus.conductor_id;
    const clientId = user.id;

    const notifications = [];

    // 3. Create notification for the client
    notifications.push({
      recipient_id: clientId,
      type: 'general',
      message: `Your booking for bus ${bus.bus_number} (${bus.route.name}) has been confirmed.`
    });

    // 4. Create notification for the driver
    if (driverId) {
      notifications.push({
        recipient_id: driverId,
        type: 'general',
        message: `New passenger: ${user.profile?.fullName || user.username} has booked a seat on your bus.`
      });
    }

    // 5. Create notification for the conductor
    if (conductorId) {
      notifications.push({
        recipient_id: conductorId,
        type: 'general',
        message: `New passenger: ${user.profile?.fullName || user.username} has booked a seat on your bus.`
      });
    }

    // 6. Insert all notifications
    if (notifications.length > 0) {
      const { error: notificationError } = await supabase
        .from('notifications')
        .insert(notifications);
      if (notificationError) throw notificationError;
    }

    try {
      const to = booking.email || booking.user?.email || null;
      let routeName = booking.bus?.route?.name || null;
      if (!routeName && booking.bus_id) {
        try {
          const { data: busRow } = await supabase
            .from('buses')
            .select('route_id')
            .eq('id', booking.bus_id)
            .single();
          const routeId = busRow?.route_id || null;
          if (routeId) {
            const { data: routeRow } = await supabase
              .from('routes')
              .select('name')
              .eq('id', routeId)
              .single();
            routeName = routeRow?.name || null;
          }
        } catch (_) {}
      }
      const date = booking.travel_date || null;
      if (to) {
        await sendConfirmationEmail({ to, booking, routeName, date });
      }
    } catch (emailErr) {
      console.warn('Admin confirm: failed to send confirmation email', emailErr && emailErr.message ? emailErr.message : emailErr);
    }

    try { await syncBusAvailability(booking.bus_id); } catch (seatErr) {
      console.warn('Admin confirm: failed to sync seat availability', seatErr && seatErr.message ? seatErr.message : seatErr);
    }

    res.json(booking);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: cancel a booking (soft delete via status)
app.delete('/api/admin/booking/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .select('id, bus_id, status')
      .eq('id', id)
      .single();

    if (bookingErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.json({ message: 'Booking already cancelled' });
    }

    const { error: updateErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (updateErr) throw updateErr;

    await syncBusAvailability(booking.bus_id);

    res.json({ message: 'Booking cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ===== NOTIFICATION MANAGEMENT SYSTEM =====

// --- Admin Notification Endpoints ---

// Send notification to specific user(s)
app.post('/api/admin/notification', async (req, res) => {
  try {
    const { recipient_ids, type, message, title } = req.body;
    
    // Validate required fields
    if (!recipient_ids || !type || !message) {
      return res.status(400).json({ 
        error: 'recipient_ids, type, and message are required' 
      });
    }

    // Validate notification type against allowed values
    const allowedTypes = ['delay', 'route_change', 'traffic', 'general', 'announcement', 'maintenance'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ 
        error: 'Invalid notification type',
        allowedTypes 
      });
    }

    // Handle single recipient or multiple recipients
    const recipients = Array.isArray(recipient_ids) ? recipient_ids : [recipient_ids];
    
    // Create notifications for all recipients
    const notifications = recipients.map(recipient_id => ({
      recipient_id,
      type,
      message,
      title: title || null,
      is_read: false,
      priority: type === 'maintenance' || type === 'delay' ? 'high' : 'normal'
    }));

    const { data, error } = await supabase
      .from('notifications')
      .insert(notifications)
      .select();

    if (error) throw error;

    // Create real-time channels for new recipients
    recipients.forEach(recipient_id => {
      createNotificationChannel(recipient_id);
    });

    res.status(201).json({
      message: `Notifications sent to ${recipients.length} recipient(s)`,
      notifications: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send notification to all users of a specific role
app.post('/api/admin/notification/broadcast', async (req, res) => {
  try {
    const { role, type, message, title } = req.body;
    
    if (!role || !type || !message) {
      return res.status(400).json({ 
        error: 'role, type, and message are required' 
      });
    }

    // Get all users with the specified role
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id')
      .eq('role', role)
      .eq('status', 'active');

    if (usersError) throw usersError;

    if (!users || users.length === 0) {
      return res.status(404).json({ 
        error: `No active users found with role: ${role}` 
      });
    }

    // Create notifications for all users
    const notifications = users.map(user => ({
      recipient_id: user.id,
      type,
      message,
      title: title || null,
      is_read: false,
      priority: type === 'maintenance' || type === 'delay' ? 'high' : 'normal'
    }));

    const { data, error } = await supabase
      .from('notifications')
      .insert(notifications)
      .select();

    if (error) throw error;

    // Create real-time channels for all recipients
    users.forEach(user => {
      createNotificationChannel(user.id);
    });

    res.status(201).json({
      message: `Broadcast notification sent to ${users.length} ${role}(s)`,
      notifications: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all notifications (admin view)
app.get('/api/admin/notifications', async (req, res) => {
  try {
    const { page = 1, limit = 50, type, recipient_id, is_read } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select(`
        *,
        recipient:recipient_id(id, username, email, role, profile)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (type) query = query.eq('type', type);
    if (recipient_id) query = query.eq('recipient_id', recipient_id);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true });

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get notification statistics
app.get('/api/admin/notifications/stats', async (req, res) => {
  try {
    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('type, is_read, created_at');

    if (error) throw error;

    const stats = {
      total: notifications.length,
      unread: notifications.filter(n => !n.is_read).length,
      read: notifications.filter(n => n.is_read).length,
      byType: {},
      byDate: {}
    };

    // Count by type
    notifications.forEach(notification => {
      stats.byType[notification.type] = (stats.byType[notification.type] || 0) + 1;
    });

    // Count by date (last 7 days)
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - i);
      return date.toISOString().split('T')[0];
    });

    last7Days.forEach(date => {
      stats.byDate[date] = notifications.filter(n => 
        n.created_at.startsWith(date)
      ).length;
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: delete a notification by ID
app.delete('/api/admin/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: exists, error: checkErr } = await supabase
      .from('notifications')
      .select('id')
      .eq('id', id)
      .single();
    if (checkErr || !exists) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/contacts', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, email } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('contacts')
      .select('id, full_name, email, message, status, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (email) query = query.ilike('email', `%${email}%`);

    const { data, error } = await query;
    if (error) throw error;

    const { count } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });

    res.json({
      contacts: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// --- Client Notification Endpoints ---

// Get client's notifications with pagination and filters
app.get('/api/client/notifications', async (req, res) => {
  try {
    const { userId, page = 1, limit = 20, type, is_read, priority } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select(`
        *,
        bus:bus_id(bus_number, route:route_id(name))
      `)
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (type) query = query.eq('type', type);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');
    if (priority) query = query.eq('priority', priority);

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', userId);

    // Create real-time channel for this user
    createNotificationChannel(userId);

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark notification as read
app.put('/api/client/notification/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify the notification belongs to the user
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', userId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    // Mark as read
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark all notifications as read for a user
// backend
app.put('/api/client/notifications/:userId/read-all', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('recipient_id', userId)
      .eq('is_read', false)
      .select();

    if (error) throw error;

    res.json({
      message: `Marked ${data.length} notifications as read`,
      updatedCount: data.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a specific notification
app.delete('/api/client/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify the notification belongs to the user
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', userId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    // Delete the notification
    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete all read notifications for a user
app.delete('/api/client/notifications/delete-read', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('notifications')
      .delete()
      .eq('recipient_id', userId)
      .eq('is_read', true)
      .select();

    if (error) throw error;

    res.json({
      message: `Deleted ${data.length} read notifications`,
      deletedCount: data.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get unread notification count for a user
app.get('/api/client/notifications/unread-count', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', userId)
      .eq('is_read', false);

    if (error) throw error;

    res.json({ unreadCount: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Discount Verification Endpoints ---

// Client: Submit discount verification request
app.post('/api/client/discount-verification', async (req, res) => {
  console.log('Received discount verification submission');
  try {
    if (!supabaseAdmin) {
      console.error('Supabase service role is not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const { userId, type, idImageUrl, email, username, fullName } = req.body;
    console.log(`Submitting verification for user: ${userId}, type: ${type}`);

    if (!userId || !type || !idImageUrl) {
      return res.status(400).json({ error: 'userId, type, and idImageUrl are required' });
    }

    const { data: userRow, error: userCheckError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', userId)
      .maybeSingle();
    if (userCheckError && userCheckError.code !== 'PGRST116') {
      throw userCheckError;
    }
    if (!userRow) {
      const { error: userInsertError } = await supabaseAdmin
        .from('users')
        .insert({
          id: userId,
          email: email || `user_${userId}@example.com`,
          username: username || (email ? email.split('@')[0] : `user_${String(userId).slice(0, 8)}`),
          role: 'client',
          status: 'active',
          profile: fullName ? { fullName } : {}
        });
      if (userInsertError && userInsertError.code !== '23505') {
        throw userInsertError;
      }
    }

    // Check if there's an existing pending verification
    // Use supabaseAdmin to bypass RLS
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('discount_verifications')
      .select('id, status')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .maybeSingle();
      
    if (existingError) {
      console.error('Error checking existing verification:', existingError);
      throw existingError;
    }

    if (existing) {
      return res.status(400).json({ error: 'You already have a pending verification request' });
    }

    const { data, error } = await supabaseAdmin
      .from('discount_verifications')
      .insert({
        user_id: userId,
        type,
        id_image_url: idImageUrl,
        status: 'pending',
        submitted_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Error inserting verification:', error);
      throw error;
    }

    console.log('Verification submitted successfully:', data);
    res.status(201).json(data);
  } catch (error) {
    console.error('Discount verification submission error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Client: Get discount verification status
app.get('/api/client/discount-verification/:userId', async (req, res) => {
  try {
    if (!supabaseAdmin) {
       return res.status(500).json({ error: 'Server configuration error' });
    }
    const { userId } = req.params;

    // Use supabaseAdmin to bypass RLS
    const { data, error } = await supabaseAdmin
      .from('discount_verifications')
      .select('*')
      .eq('user_id', userId)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.json({ status: 'none' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Get discount verifications with filters and pagination
app.get('/api/admin/discount-verifications', async (req, res) => {
  try {
    if (!supabaseAdmin) {
       return res.status(500).json({ error: 'Server configuration error' });
    }
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('discount_verifications')
      .select(`
        *,
        user:user_id(id, username, email, profile)
      `, { count: 'exact' });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query
      .order('submitted_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      verifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Approve/Reject discount verification
app.put('/api/admin/discount-verification/:id', async (req, res) => {
  try {
    if (!supabaseAdmin) {
       return res.status(500).json({ error: 'Server configuration error' });
    }
    const { id } = req.params;
    const { status, rejectionReason, adminId } = req.body;

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be approved or rejected' });
    }

    const { data: verification, error: updateError } = await supabaseAdmin
      .from('discount_verifications')
      .update({
        status,
        rejection_reason: status === 'rejected' ? rejectionReason : null,
        verified_at: new Date().toISOString(),
        verified_by: adminId
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Notify the user
    await supabaseAdmin.from('notifications').insert({
      recipient_id: verification.user_id,
      type: 'general',
      title: 'Discount Verification Update',
      message: `Your discount verification for ${verification.type} has been ${status}.${status === 'rejected' ? ` Reason: ${rejectionReason}` : ''}`
    });

    res.json(verification);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Employee Notification Endpoints ---

// Get employee's notifications
app.get('/api/employee/notifications', async (req, res) => {
  try {
    const { employeeId, page = 1, limit = 20, type, is_read } = req.query;
    
    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select(`
        *,
        bus:bus_id(bus_number, route:route_id(name))
      `)
      .eq('recipient_id', employeeId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (type) query = query.eq('type', type);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', employeeId);

    // Create real-time channel for this employee
    createNotificationChannel(employeeId);

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark employee notification as read
app.put('/api/employee/notification/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Verify the notification belongs to the employee
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', employeeId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    // Mark as read
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an employee's notification
app.delete('/api/employee/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Verify the notification belongs to the employee
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', employeeId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Employee: send a notification to all passengers currently booked on their bus
app.post('/api/employee/notification/broadcast', async (req, res) => {
  try {
    const { employeeId, busId, type, message, title } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }
    if (!busId) {
      return res.status(400).json({ error: 'Bus ID is required' });
    }
    if (!type || !message) {
      return res.status(400).json({ error: 'type and message are required' });
    }

    // Validate notification type against allowed values
    const allowedTypes = ['delay', 'route_change', 'traffic', 'general', 'announcement', 'maintenance'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid notification type',
        allowedTypes
      });
    }

    // Passengers of THIS bus only = distinct user_ids from active bookings on busId
    const { data: bookings, error: bookingsError } = await supabase
      .from('bookings')
      .select('user_id, status')
      .eq('bus_id', busId)
      .neq('status', 'cancelled');

    if (bookingsError) throw bookingsError;

    const passengerIds = [...new Set((bookings || [])
      .map(b => b.user_id)
      .filter(Boolean))];

    if (passengerIds.length === 0) {
      return res.status(404).json({ error: 'No active passengers found for this bus' });
    }

    const notifications = passengerIds.map(recipient_id => ({
      recipient_id,
      bus_id: busId,
      type,
      message,
      title: title || null,
      is_read: false,
      priority: type === 'maintenance' || type === 'delay' ? 'high' : 'normal'
    }));

    const { data, error } = await supabase
      .from('notifications')
      .insert(notifications)
      .select(`
        *,
        bus:bus_id(bus_number, route:route_id(name))
      `);

    if (error) throw error;

    // Push over real-time channels
    passengerIds.forEach(recipient_id => {
      createNotificationChannel(recipient_id);
    });

    res.status(201).json({
      message: `Notification sent to ${passengerIds.length} passenger(s) on this bus`,
      count: passengerIds.length,
      notifications: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Utility Endpoints ---

// Test endpoint to verify routing
app.get('/api/admin/notification/test', (req, res) => {
  console.log('🧪 Test endpoint hit!');
  res.json({ message: 'Notification routing is working!' });
});

// Get notifications by recipient ID (admin view)
app.get('/api/admin/notification/recipient/:recipient_id', async (req, res) => {
  try {
    const { recipient_id } = req.params;
    const { type, is_read, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    if (!recipient_id) {
      return res.status(400).json({ error: 'Recipient ID is required' });
    }

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', recipient_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) query = query.eq('type', type);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', recipient_id);

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific notification by ID (admin view)
app.get('/api/admin/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Notification ID is required' });
    }

    const { data: notification, error } = await supabase
      .from('notifications')
      .select(`
        *,
        recipient:recipient_id(id, username, email, role, profile)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Notification not found' });
      }
      throw error;
    }

    res.json(notification);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Report Management (Admin) ---
// Get all reports
app.get('/api/admin/reports', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select(`
        id,
        type,
        description,
        created_at,
        employee:employee_id(id, username, email, profile),
        bus:bus_id(id, bus_number)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: delete a report by ID
app.delete('/api/admin/report/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: report, error: checkErr } = await supabase
      .from('reports')
      .select('id')
      .eq('id', id)
      .single();
    if (checkErr || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Terminals ---
// Add Terminal (requires map-verified coordinates)
app.post('/api/admin/terminal', async (req, res) => {
  try {
    const { name, address, lat, lng, place_id, formatted_address, map_verified } = req.body;

    if (!name || !address) {
      return res.status(400).json({ error: 'Name and address are required' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Terminal location must be verified on the map (valid lat/lng required)' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    if (map_verified !== true) {
      return res.status(400).json({ error: 'Terminal must be confirmed on the map before saving (map_verified: true)' });
    }

    const { data, error } = await supabase
      .from('terminals')
      .insert([{
        name,
        address,
        lat,
        lng,
        place_id: place_id || null,
        formatted_address: formatted_address || address,
        map_verified: true,
      }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Terminals
app.get('/api/admin/terminals', async (req, res) => {
  try {
    console.log('Fetching all terminals...');
    
    const { data, error } = await supabase
      .from('terminals')
      .select('*');
      
    if (error) {
      console.error('Error fetching terminals:', error);
      return res.status(500).json({ error: 'Error fetching terminals', details: error.message });
    }
    
    console.log('Terminals fetched:', data);
    res.json(data);
  } catch (error) {
    console.error('Unexpected error in terminals fetch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Edit Terminal
app.put('/api/admin/terminal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address, lat, lng, place_id, formatted_address, map_verified } = req.body;

    if (!name || !address) {
      return res.status(400).json({ error: 'Name and address are required' });
    }

    const { data: existingTerminal, error: checkError } = await supabase
      .from('terminals')
      .select('id, lat, lng, map_verified')
      .eq('id', id)
      .single();

    if (checkError || !existingTerminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    const payload = { name, address };

    if (lat !== undefined || lng !== undefined || map_verified !== undefined) {
      if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'Valid lat/lng required when updating map location' });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'Invalid coordinates' });
      }
      if (map_verified !== true) {
        return res.status(400).json({ error: 'Re-confirm the terminal location on the map before saving' });
      }
      payload.lat = lat;
      payload.lng = lng;
      payload.place_id = place_id || null;
      payload.formatted_address = formatted_address || address;
      payload.map_verified = true;
    } else if (!existingTerminal.map_verified) {
      return res.status(400).json({
        error: 'This terminal has no verified map location. Please set location using the map picker.',
      });
    }

    const { data, error } = await supabase
      .from('terminals')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Terminal
app.delete('/api/admin/terminal/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if terminal exists
    const { data: existingTerminal, error: checkError } = await supabase
      .from('terminals')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError || !existingTerminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    // Check if terminal is being used by any routes
    const { data: routesUsingTerminal, error: routesError } = await supabase
      .from('routes')
      .select('id, name')
      .or(`start_terminal_id.eq.${id},end_terminal_id.eq.${id}`);

    if (routesError) throw routesError;

    if (routesUsingTerminal && routesUsingTerminal.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete terminal',
        message: 'Terminal is being used by routes',
        routes: routesUsingTerminal.map(route => ({ id: route.id, name: route.name }))
      });
    }

    // Check if terminal is being used by any route stops
    const { data: stopsUsingTerminal, error: stopsError } = await supabase
      .from('route_stops')
      .select('id, route_id')
      .eq('terminal_id', id);

    if (stopsError) throw stopsError;

    if (stopsUsingTerminal && stopsUsingTerminal.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete terminal',
        message: 'Terminal is being used as a stop in routes',
        stops: stopsUsingTerminal
      });
    }

    // Delete terminal
    const { error } = await supabase
      .from('terminals')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Terminal deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== REFUND REQUESTS =====
// Create a client refund request
app.post('/api/client/refund', async (req, res) => {
  try {
    const { full_name, email, reason, proof_url, agree, booking_id } = req.body || {};
    if (!full_name || !email || !reason) {
      return res.status(400).json({ error: 'full_name, email, and reason are required' });
    }
    if (agree !== true) {
      return res.status(400).json({ error: 'You must agree to the refund policy' });
    }
    const payload = {
      full_name,
      email,
      reason,
      proof_url: proof_url || null,
      booking_id: booking_id || null,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    const { data, error } = await supabase
      .from('refund_requests')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create refund request' });
  }
});

// Upload refund proof (server-side to bypass RLS)
app.post('/api/client/refund/upload', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase service role is not configured on server' });
    }
    const { file_base64, filename, content_type, user_id, email } = req.body || {};
    if (!file_base64 || !filename) {
      return res.status(400).json({ error: 'file_base64 and filename are required' });
    }
    // Create a path under refund-images bucket
    const owner = (user_id || email || 'anonymous').toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = Date.now();
    const path = `${owner}/${ts}-${filename}`;
    const buffer = Buffer.from(file_base64, 'base64');
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('refund-images')
      .upload(path, buffer, { contentType: content_type || 'application/octet-stream', upsert: true });
    if (uploadErr) throw uploadErr;
    const { data } = supabaseAdmin.storage.from('refund-images').getPublicUrl(path);
    return res.json({ publicUrl: data.publicUrl, path });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to upload file' });
  }
});

// Upload ID for discount verification
app.post('/api/client/discount/upload', async (req, res) => {
  console.log('Received discount ID upload request');
  try {
    if (!supabaseAdmin) {
      console.error('Supabase service role is not configured on server');
      return res.status(500).json({ error: 'Supabase service role is not configured on server' });
    }
    const { file_base64, filename, content_type, user_id, email } = req.body || {};
    
    console.log(`Processing upload for user: ${user_id || email}, filename: ${filename}`);

    if (!file_base64 || !filename) {
      console.error('Missing file_base64 or filename');
      return res.status(400).json({ error: 'file_base64 and filename are required' });
    }
    // Create a path under ID bucket
    const owner = (user_id || email || 'anonymous').toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = Date.now();
    const path = `${owner}/${ts}-${filename}`;
    const buffer = Buffer.from(file_base64, 'base64');
    
    // Upload to 'ID' bucket
    console.log(`Uploading to bucket 'ID' at path: ${path}`);
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('ID')
      .upload(path, buffer, { contentType: content_type || 'application/octet-stream', upsert: true });
    
    if (uploadErr) {
      console.error('Supabase upload error:', uploadErr);
      throw uploadErr;
    }
    
    const { data } = supabaseAdmin.storage.from('ID').getPublicUrl(path);
    console.log('Upload successful, public URL:', data.publicUrl);
    return res.json({ publicUrl: data.publicUrl, path });
  } catch (error) {
    console.error('Upload endpoint error:', error);
    return res.status(500).json({ error: error.message || 'Failed to upload ID' });
  }
});

// List refund requests (admin)
app.get('/api/admin/refunds', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase service role is not configured on server' });
    }
    const { page = 1, limit = 50 } = req.query;
    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(200, Number(limit)));
    const from = (p - 1) * l;
    const to = from + l - 1;
    const { data, error, count } = await supabaseAdmin
      .from('refund_requests')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    res.json({ refunds: data || [], pagination: { page: p, limit: l, total: count || 0, totalPages: Math.ceil((count || 0) / l) } });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch refunds' });
  }
});

// Get single refund request (admin)
app.get('/api/admin/refunds/:id', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase service role is not configured on server' });
    }
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('refund_requests')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Refund not found' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch refund' });
  }
});

// Update refund status (admin)
app.put('/api/admin/refund/:id/status', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase service role is not configured on server' });
    }
    const { id } = req.params;
    const { status, note } = req.body || {};
    const allowed = ['pending', 'approved', 'rejected'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { data, error } = await supabaseAdmin
      .from('refund_requests')
      .update({ status, note: note || null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update refund' });
  }
});

// --- Routes ---
// Add Route (with stops)
app.post('/api/admin/route', async (req, res) => {
  try {
    const { name, start_terminal_id, end_terminal_id, stops } = req.body;
    const fare_per_seat = req.body.fare_per_seat == null ? 15 : Number(req.body.fare_per_seat);
    
    console.log('Creating route with data:', { name, start_terminal_id, end_terminal_id, fare_per_seat, stops });
    
    // Validate required fields
    if (!name || !start_terminal_id || !end_terminal_id) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['name', 'start_terminal_id', 'end_terminal_id'],
        received: { name, start_terminal_id, end_terminal_id }
      });
    }
    if (!Number.isFinite(fare_per_seat) || fare_per_seat < 0) {
      return res.status(400).json({ error: 'fare_per_seat must be a valid non-negative number' });
    }

    // Check if terminals exist
    const { data: terminals, error: terminalsError } = await supabase
      .from('terminals')
      .select('id, name')
      .in('id', [start_terminal_id, end_terminal_id]);

    if (terminalsError) {
      console.error('Error checking terminals:', terminalsError);
      return res.status(500).json({ error: 'Error checking terminals', details: terminalsError.message });
    }

    if (terminals.length !== 2) {
      return res.status(400).json({ 
        error: 'Start or end terminal not found',
        found_terminals: terminals,
        requested_terminals: [start_terminal_id, end_terminal_id]
      });
    }

    // Create route
    const { data: route, error: routeError } = await supabase
      .from('routes')
      .insert([{ name, start_terminal_id, end_terminal_id, fare_per_seat }])
      .select()
      .single();
    
    if (routeError) {
      console.error('Error creating route:', routeError);
      return res.status(500).json({ error: 'Error creating route', details: routeError.message });
    }

    console.log('Route created successfully:', route);

    // Insert stops if provided
    if (Array.isArray(stops) && stops.length > 0) {
      const stopsData = stops.map((terminal_id, idx) => ({
        route_id: route.id,
        terminal_id,
        stop_order: idx + 1
      }));
      
      console.log('Creating stops:', stopsData);
      
      const { data: createdStops, error: stopsError } = await supabase
        .from('route_stops')
        .insert(stopsData)
        .select();
        
      if (stopsError) {
        console.error('Error creating stops:', stopsError);
        return res.status(500).json({ error: 'Error creating route stops', details: stopsError.message });
      }
      
      console.log('Stops created successfully:', createdStops);
    }
    
    res.status(201).json(route);
  } catch (error) {
    console.error('Unexpected error in route creation:', error);
    res.status(500).json({ error: error.message });
  }
});

// List Routes (with stops)
app.get('/api/admin/routes', async (req, res) => {
  try {
    console.log('Fetching all routes...');
    
    // Get all routes
    const { data: routes, error: routesError } = await supabase
      .from('routes')
      .select('*');
      
    if (routesError) {
      console.error('Error fetching routes:', routesError);
      return res.status(500).json({ error: 'Error fetching routes', details: routesError.message });
    }
    
    console.log('Routes fetched:', routes);

    // Get all stops
    const { data: stops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*');
      
    if (stopsError) {
      console.error('Error fetching stops:', stopsError);
      return res.status(500).json({ error: 'Error fetching stops', details: stopsError.message });
    }
    
    console.log('Stops fetched:', stops);

    // Attach stops to routes
    const routesWithStops = routes.map(route => ({
      ...route,
      stops: stops.filter(stop => stop.route_id === route.id)
    }));
    
    console.log('Routes with stops:', routesWithStops);
    
    res.json(routesWithStops);
  } catch (error) {
    console.error('Unexpected error in routes fetch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Edit Route
app.put('/api/admin/route/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_terminal_id, end_terminal_id, stops } = req.body;
    const fare_per_seat = req.body.fare_per_seat == null ? 15 : Number(req.body.fare_per_seat);

    // Validate required fields
    if (!name || !start_terminal_id || !end_terminal_id) {
      return res.status(400).json({ error: 'Name, start_terminal_id, and end_terminal_id are required' });
    }
    if (!Number.isFinite(fare_per_seat) || fare_per_seat < 0) {
      return res.status(400).json({ error: 'fare_per_seat must be a valid non-negative number' });
    }

    // Check if route exists
    const { data: existingRoute, error: checkError } = await supabase
      .from('routes')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError || !existingRoute) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Validate terminals exist
    const { data: terminals, error: terminalsError } = await supabase
      .from('terminals')
      .select('id')
      .in('id', [start_terminal_id, end_terminal_id]);

    if (terminalsError) throw terminalsError;

    if (terminals.length !== 2) {
      return res.status(400).json({ error: 'Start or end terminal not found' });
    }

    // Update route
    const { data: updatedRoute, error: routeError } = await supabase
      .from('routes')
      .update({ name, start_terminal_id, end_terminal_id, fare_per_seat })
      .eq('id', id)
      .select()
      .single();

    if (routeError) throw routeError;

    // Update stops if provided
    if (Array.isArray(stops)) {
      // Delete existing stops
      await supabase
        .from('route_stops')
        .delete()
        .eq('route_id', id);

      // Insert new stops if any
      if (stops.length > 0) {
        const stopsData = stops.map((terminal_id, idx) => ({
          route_id: id,
          terminal_id,
          stop_order: idx + 1
        }));

        const { error: stopsError } = await supabase
          .from('route_stops')
          .insert(stopsData);

        if (stopsError) throw stopsError;
      }
    }

    // Get updated route with stops
    const { data: finalRoute, error: finalError } = await supabase
      .from('routes')
      .select('*')
      .eq('id', id)
      .single();

    if (finalError) throw finalError;

    // Get stops for the route
    const { data: routeStops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*')
      .eq('route_id', id);

    if (stopsError) throw stopsError;

    const routeWithStops = {
      ...finalRoute,
      stops: routeStops || []
    };

    res.json(routeWithStops);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Route
app.delete('/api/admin/route/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if route exists
    const { data: existingRoute, error: checkError } = await supabase
      .from('routes')
      .select('id, name')
      .eq('id', id)
      .single();

    if (checkError || !existingRoute) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Check if route is being used by any buses
    const { data: busesUsingRoute, error: busesError } = await supabase
      .from('buses')
      .select('id, bus_number')
      .eq('route_id', id);

    if (busesError) throw busesError;

    if (busesUsingRoute && busesUsingRoute.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete route',
        message: 'Route is being used by buses',
        buses: busesUsingRoute.map(bus => ({ id: bus.id, bus_number: bus.bus_number }))
      });
    }

    // Delete route stops first (due to foreign key constraint)
    await supabase
      .from('route_stops')
      .delete()
      .eq('route_id', id);

    // Delete route
    const { error } = await supabase
      .from('routes')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single terminal by ID
app.get('/api/admin/terminal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('terminals')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single route by ID (with stops)
app.get('/api/admin/route/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get route
    const { data: route, error: routeError } = await supabase
      .from('routes')
      .select('*')
      .eq('id', id)
      .single();

    if (routeError) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Get stops for the route
    const { data: stops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*')
      .eq('route_id', id)
      .order('stop_order', { ascending: true });

    if (stopsError) throw stopsError;

    const routeWithStops = {
      ...route,
      stops: stops || []
    };

    res.json(routeWithStops);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Buses ---
// Register New Bus
app.post('/api/admin/bus', async (req, res) => {
  try {
    const { bus_number, total_seats, standing_capacity, terminal_id, route_id } = req.body;
    const resolvedStandingCapacity = Number(standing_capacity || 0);
    if (!Number.isInteger(resolvedStandingCapacity) || resolvedStandingCapacity < 0) {
      return res.status(400).json({ error: 'standing_capacity must be a non-negative whole number' });
    }
    const { data, error } = await supabase
      .from('buses')
      .insert([{
        bus_number, total_seats, available_seats: total_seats,
        standing_capacity: resolvedStandingCapacity,
        available_standing: resolvedStandingCapacity,
        terminal_id, route_id,
      }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single Bus by ID (admin)
app.get('/api/admin/bus/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: bus, error } = await supabase
      .from('buses')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    res.json(bus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Buses (for fleet)
app.get('/api/admin/buses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('*');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Bus (admin)
app.put('/api/admin/bus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      bus_number,
      total_seats,
      standing_capacity,
      terminal_id,
      route_id,
      status,
      current_location,
      driver_id,
      conductor_id
    } = req.body;

    // Ensure bus exists
    const { data: existingBus, error: existingError } = await supabase
      .from('buses')
      .select('id, available_seats, total_seats, available_standing, standing_capacity')
      .eq('id', id)
      .single();
    if (existingError || !existingBus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Optional validations
    if (typeof total_seats === 'number' && total_seats < 0) {
      return res.status(400).json({ error: 'total_seats must be >= 0' });
    }
    if (standing_capacity !== undefined && (!Number.isInteger(Number(standing_capacity)) || Number(standing_capacity) < 0)) {
      return res.status(400).json({ error: 'standing_capacity must be a non-negative whole number' });
    }

    // Validate terminal/route existence if provided
    if (terminal_id) {
      const { data: term, error: termErr } = await supabase
        .from('terminals')
        .select('id')
        .eq('id', terminal_id)
        .single();
      if (termErr || !term) return res.status(400).json({ error: 'Invalid terminal_id' });
    }
    if (route_id) {
      const { data: route, error: routeErr } = await supabase
        .from('routes')
        .select('id')
        .eq('id', route_id)
        .single();
      if (routeErr || !route) return res.status(400).json({ error: 'Invalid route_id' });
    }

    // If bus_number is changing, ensure uniqueness
    if (bus_number) {
      const { data: dupCheck, error: dupErr } = await supabase
        .from('buses')
        .select('id')
        .eq('bus_number', bus_number)
        .neq('id', id);
      if (dupErr) throw dupErr;
      if (Array.isArray(dupCheck) && dupCheck.length > 0) {
        return res.status(400).json({ error: 'bus_number already exists' });
      }
    }

    const updatePayload = {
      ...(bus_number !== undefined ? { bus_number } : {}),
      ...(total_seats !== undefined ? { total_seats } : {}),
      ...(standing_capacity !== undefined ? { standing_capacity: Number(standing_capacity) } : {}),
      ...(terminal_id !== undefined ? { terminal_id } : {}),
      ...(route_id !== undefined ? { route_id } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(current_location !== undefined ? { current_location } : {}),
      ...(driver_id !== undefined ? { driver_id } : {}),
      ...(conductor_id !== undefined ? { conductor_id } : {}),
    };

    const { data: updated, error } = await supabase
      .from('buses')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(await syncBusAvailability(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Bus (admin)
app.delete('/api/admin/bus/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure bus exists
    const { data: bus, error: busErr } = await supabase
      .from('buses')
      .select('id, bus_number')
      .eq('id', id)
      .single();
    if (busErr || !bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Detach any users assigned to this bus to avoid FK constraint
    await supabase
      .from('users')
      .update({ assigned_bus_id: null })
      .eq('assigned_bus_id', id);

    // Check dependent records that would block deletion
    const [{ count: bookingsCount }, { count: feedbacksCount }, { count: reportsCount }] = await Promise.all([
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('bus_id', id),
      supabase.from('feedbacks').select('*', { count: 'exact', head: true }).eq('bus_id', id),
      supabase.from('reports').select('*', { count: 'exact', head: true }).eq('bus_id', id),
    ]);

    if ((bookingsCount || 0) > 0 || (feedbacksCount || 0) > 0 || (reportsCount || 0) > 0) {
      return res.status(400).json({
        error: 'Cannot delete bus. It has dependent records.',
        details: {
          bookings: bookingsCount || 0,
          feedbacks: feedbacksCount || 0,
          reports: reportsCount || 0
        }
      });
    }

    const { error } = await supabase
      .from('buses')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: `Bus ${bus.bus_number} deleted successfully` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Live Map ---
// Get all bus locations
app.get('/api/admin/bus-locations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('id, bus_number, current_location');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Receive live location updates from employee devices.
app.put('/api/employee/location', async (req, res) => {
  try {
    const { lat, lng, employeeId, busId, accuracy, speed, heading } = req.body || {};

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ message: 'lat and lng are required numbers' });
    }

    const payload = {
      lat,
      lng,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      speed: typeof speed === 'number' ? speed : null,
      heading: typeof heading === 'number' ? heading : null,
      employeeId: employeeId || null,
      busId: busId || null,
      timestamp: new Date().toISOString(),
    };

    if (payload.busId) {
      latestLocationsByBusId.set(payload.busId, payload);

      await supabase
        .from('buses')
        .update({ current_location: { lat: payload.lat, lng: payload.lng } })
        .eq('id', payload.busId);
    }

    try {
      await supabase.from('bus_locations').insert({
        bus_id: payload.busId,
        employee_id: payload.employeeId,
        lat: payload.lat,
        lng: payload.lng,
        accuracy: payload.accuracy,
        speed: payload.speed,
        heading: payload.heading,
        recorded_at: payload.timestamp,
      });
    } catch (locationLogError) {
      console.warn('bus_locations insert skipped:', locationLogError?.message || locationLogError);
    }

    broadcastLiveLocation(payload);
    res.json({ success: true, location: payload });
  } catch (error) {
    console.error('Location update failed:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Admin: latest location for one bus.
app.get('/api/admin/bus/:busId/location', async (req, res) => {
  try {
    const { busId } = req.params;
    const latest = latestLocationsByBusId.get(busId);
    if (latest) return res.json({ busId, latest });

    const { data, error } = await supabase
      .from('buses')
      .select('current_location')
      .eq('id', busId)
      .single();

    if (error) throw error;
    const currentLocation = normalizeLatLng(data?.current_location);
    res.json({
      busId,
      latest: currentLocation ? { ...currentLocation, busId, timestamp: null } : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: list latest known locations for all buses.
app.get('/api/admin/locations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('id, current_location');

    if (error) throw error;

    const locations = (data || [])
      .map((bus) => {
        const live = latestLocationsByBusId.get(bus.id);
        const fallback = normalizeLatLng(bus.current_location);
        const latest = live || (fallback ? { ...fallback, busId: bus.id, timestamp: null } : null);
        return latest ? { busId: bus.id, latest } : null;
      })
      .filter(Boolean);

    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: subscribe to live location updates with Server-Sent Events.
app.get('/api/admin/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');

  liveLocationClients.add(res);
  req.on('close', () => {
    liveLocationClients.delete(res);
  });
});

// --- Client API ---

// Get all buses for client (with route info)
app.get('/api/client/buses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('*, route:routes(name, fare_per_seat)')
      .eq('status', 'active');

    if (error) throw error;

    const transformed = data.map(({ route, ...bus }) => ({
      ...bus,
      route_name: route?.name ?? null,
      fare_per_seat: route?.fare_per_seat ?? 15
    }));

    res.json(transformed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get ETAs for client
app.get('/api/client/bus-eta', async (req, res) => {
  try {
    const { data: buses, error } = await supabase
      .from('buses')
      .select(`
        id, bus_number, current_location,
        departure_status, scheduled_departure_time, actual_departure_time, departure_status_note,
        route:routes(name, start_terminal_id, end_terminal_id, fare_per_seat)
      `)
      .eq('status', 'active');
 
    if (error) throw error;

    // Supabase returns a nested object for this many-to-one relationship. Keep
    // the normalization here so a malformed/legacy relation cannot remove the
    // route from the ETA payload consumed by the tracker.
    const getRoute = (bus) => Array.isArray(bus.route)
      ? bus.route[0] || null
      : bus.route || null;

    const terminalIds = Array.from(new Set(
      buses.flatMap(bus => [getRoute(bus)?.end_terminal_id].filter(Boolean))
    ));

    let terminalMap = new Map();
    if (terminalIds.length > 0) {
      const { data: terminals, error: terminalError } = await supabase
        .from('terminals')
        .select('id, lat, lng')
        .in('id', terminalIds);

      if (terminalError) throw terminalError;
      terminalMap = new Map((terminals || []).map(terminal => [terminal.id, terminal]));
    }

    const now = Date.now();
    const LIVE_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;

    const etas = buses.map(bus => {
      const route = getRoute(bus);
      const tracked = latestLocationsByBusId.get(bus.id);
      const trackedLocation = normalizeLatLng(tracked);
      const databaseLocation = normalizeLatLng(bus.current_location);
      const currentLocation = trackedLocation || databaseLocation;

      const trackedTimestamp = tracked?.timestamp ? Date.parse(tracked.timestamp) : NaN;
      const hasRecentLiveLocation =
        Boolean(trackedLocation) &&
        Number.isFinite(trackedTimestamp) &&
        now - trackedTimestamp <= LIVE_LOCATION_MAX_AGE_MS;

      const destination = route?.end_terminal_id
        ? normalizeLatLng(terminalMap.get(route.end_terminal_id))
        : null;

      // A persisted location remains useful for a rough ETA after the live
      // session expires. `locationSource` below still tells the client whether
      // the position is live or the last database location.
      const eta = calculateBusEta(currentLocation, destination, tracked?.speed);

      return {
        busId: bus.id,
        busNumber: bus.bus_number,
        route,
        eta,
        currentLocation,
        locationSource: hasRecentLiveLocation
          ? 'employee_live'
          : databaseLocation
            ? 'database'
            : null,
        departureStatus: bus.departure_status || null,
        scheduledDepartureTime: bus.scheduled_departure_time || null,
        actualDepartureTime: bus.actual_departure_time || null,
        departureStatusNote: bus.departure_status_note || null,
      };
    });

    res.json(etas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Employee Routes
app.post('/api/employee/report', async (req, res) => {
  try {
    const { employeeId, busId, type, description } = req.body;
    const { data: report, error } = await supabase
      .from('reports')
      .insert({ employee_id: employeeId, bus_id: busId, type, description })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Employee: delete own report
app.delete('/api/employee/report/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Verify report belongs to employee
    const { data: report, error: checkErr } = await supabase
      .from('reports')
      .select('id, employee_id')
      .eq('id', id)
      .eq('employee_id', employeeId)
      .single();

    if (checkErr || !report) {
      return res.status(404).json({ error: 'Report not found or access denied' });
    }

    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/employee/passenger-count/:busId', async (req, res) => {
  try {
    const bus = await syncBusAvailability(req.params.busId);
    res.json({ ...bus, message: 'Capacity is calculated automatically from reservations and pickup assignments.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Authentication Routes (using Supabase Auth)
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, username, role, profile } = req.body;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username, role } }
    });

    if (error) throw error;

    const { error: profileError } = await supabase
      .from('users')
      .upsert({ id: data.user.id, username, email, role, profile }, { onConflict: 'id' });

    if (profileError) throw profileError;

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Login error:', error);

    // Detect network / DNS errors (e.g., ENOTFOUND) coming from underlying fetch
    const cause = error && error.cause ? error.cause : null;
    const isNetworkError = cause && (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN' || cause.errno === -3008);

    if (isNetworkError) {
      // 503 indicates upstream service unavailable
      return res.status(503).json({
        error: 'Unable to reach Supabase. Check SUPABASE_URL, internet connection, and DNS settings.'
      });
    }

    // Fallback - return generic server error
    return res.status(500).json({ error: (error && error.message) ? error.message : String(error) });
  }
});


app.put('/api/employee/bus-status/:busId', async (req, res) => {
  try {
    const { busId } = req.params;
    const {
      status,
      scheduled_departure_time, 
      actual_departure_time, 
      status_note, 
    } = req.body || {};

    const allowedStatuses = ['scheduled', 'departed', 'delayed', 'arrived', 'cancelled'];
    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid or missing status', allowedStatuses });
    }
    const { data: existingBus, error: existingError } = await supabase
      .from('buses')
      .select('id')
      .eq('id', busId)
      .single();
    if (existingError || !existingBus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    const updatePayload = {
      departure_status: status,
      scheduled_departure_time: scheduled_departure_time || null,
      actual_departure_time: actual_departure_time || null,
      departure_status_note: status_note || null,
      departure_status_updated_at: new Date().toISOString(),
    };

    const { data: updatedBus, error: updateError } = await supabase
      .from('buses')
      .update(updatePayload)
      .eq('id', busId)
      .select(`
        *,
        driver:driver_id(id, username, email, profile),
        conductor:conductor_id(id, username, email, profile),
        route:route_id(name, start_terminal_id, end_terminal_id)
      `)
      .single();

    if (updateError) throw updateError;

    if (status === 'arrived') {
      const { error: completionError } = await supabase
        .from('bookings')
        .update({ status: 'completed' })
        .eq('bus_id', busId)
        .eq('status', 'boarded');
      if (completionError) console.warn('Could not complete boarded bookings:', completionError.message);
    }

    res.json(updatedBus);
  } catch (error) {
    console.error('Failed to update bus departure status:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: error?.message || 'Invalid authentication token' });
    }

    const authUser = data.user;
    let profile = null;
    try {
      const client = supabaseAdmin || supabase;
      const { data: userRow, error: userRowError } = await client
        .from('users')
        .select('id, username, email, role, profile')
        .eq('id', authUser.id)
        .single();
      if (userRowError) console.error('auth/me: users lookup failed:', userRowError);
      profile = userRow || null;
    } catch (e) {
      console.error('auth/me: users lookup threw:', e);
      profile = null;
    }

    return res.json({
      user: {
        id: authUser.id,
        email: authUser.email,
        username: profile?.username || authUser.user_metadata?.username || '',
        role: profile?.role || authUser.user_metadata?.role || 'client',
        profile: profile?.profile || authUser.user_metadata || {},
        user_metadata: authUser.user_metadata || {},
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to get current user' });
  }
});

app.post('/api/auth/logout', async (_req, res) => {
  return res.json({ success: true, message: 'Logout successful' });
});

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    const normalized = email.trim().toLowerCase();
    const { data: userRow, error: userError } = await supabase.from('users').select('id, email').eq('email', normalized).single();
    if (userError || !userRow) {
      return res.status(404).json({ error: 'User not found' });
    }
    const code = (Math.floor(100000 + Math.random() * 900000)).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    passwordOtpStore.set(normalized, { code, expiresAt, verified: false });
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('RESEND_API_KEY not configured; falling back to console logging OTP');
      console.log(`Password reset code for ${normalized}: ${code}`);
    } else {
      const fromAddr = process.env.RESEND_FROM_EMAIL || 'team@auroride.xyz';
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;padding:24px">
          <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e6e8ef;padding:24px">
            <h2 style="margin:0 0 12px;color:#111827">Password Reset Code</h2>
            <p style="color:#6b7280;margin:0 0 16px">Use the 6-digit code below to reset your password. This code expires in 10 minutes.</p>
            <div style="font-size:28px;font-weight:700;letter-spacing:6px;color:#db2777;text-align:center;padding:16px 0">${code}</div>
            <p style="color:#6b7280;margin:16px 0 0">If you did not request this, you can ignore this email.</p>
          </div>
        </div>
      `;
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            from: fromAddr,
            to: [normalized],
            subject: 'Your AuriRide password reset code',
            html,
          }),
        });
        if (!resp.ok) {
          try {
            const body = await resp.json();
            console.error('Resend OTP email error', body);
          } catch (_) {}
        }
      } catch (e) {
        console.error('Resend OTP request failed', e);
      }
    }
    return res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }
    const normalized = String(email).trim().toLowerCase();
    const entry = passwordOtpStore.get(normalized);
    if (!entry) {
      return res.status(404).json({ error: 'No OTP found for this email' });
    }
    if (Date.now() > entry.expiresAt) {
      passwordOtpStore.delete(normalized);
      return res.status(400).json({ error: 'OTP expired' });
    }
    if (String(code) !== entry.code) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    passwordOtpStore.set(normalized, { ...entry, verified: true });
    return res.json({ success: true, message: 'OTP verified' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

app.post('/api/auth/update-password-with-otp', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Service role key not configured' });
    }
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and newPassword are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const normalized = String(email).trim().toLowerCase();
    const entry = passwordOtpStore.get(normalized);
    if (!entry) {
      return res.status(404).json({ error: 'No OTP found for this email' });
    }
    if (Date.now() > entry.expiresAt) {
      passwordOtpStore.delete(normalized);
      return res.status(400).json({ error: 'OTP expired' });
    }
    if (String(code) !== entry.code) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    const { data: userRow, error: userError } = await supabase.from('users').select('id, email').eq('email', normalized).single();
    if (userError || !userRow) {
      return res.status(404).json({ error: 'User not found' });
    }
    let updateResp = await supabaseAdmin.auth.admin.updateUserById(userRow.id, { password: newPassword });
    if (updateResp.error && String(updateResp.error.message).toLowerCase().includes('user not found')) {
      const list = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (list && Array.isArray(list.data?.users)) {
        const byEmail = list.data.users.find(u => String(u.email).trim().toLowerCase() === normalized);
        if (byEmail?.id) {
          updateResp = await supabaseAdmin.auth.admin.updateUserById(byEmail.id, { password: newPassword });
        }
      }
    }
    if (updateResp.error) {
      const msg = updateResp.error.message || 'Failed to update password';
      const isNotFound = msg.toLowerCase().includes('user not found');
      return res.status(isNotFound ? 404 : 500).json({ error: msg });
    }
    passwordOtpStore.delete(normalized);
    return res.json({ success: true, message: 'Password updated', data: updateResp.data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update password' });
  }
});
// --- User Management (Admin) ---
// Get all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only client users
app.get('/api/admin/users/clients', async (req, res) => {
  try {
    const { data, error } = await supabase 
      .from('users')
      .select('*')
      .eq('role', 'client');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only employee users (all employee types)
app.get('/api/admin/users/employees', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .in('role', ['employee', 'driver', 'conductor'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only drivers
app.get('/api/admin/users/drivers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, employee_id, email, profile, assigned_bus_id, status, created_at')
      .eq('role', 'driver')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only conductors
app.get('/api/admin/users/conductors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, employee_id, email, profile, assigned_bus_id, status, created_at')
      .eq('role', 'conductor')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a user (admin can delete any user, including own account)
app.delete('/api/admin/user/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, username, email, role')
      .eq('id', id)
      .single();
    if (userErr || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await supabase.from('users').update({ created_by: null }).eq('created_by', id);
    await supabase.from('buses').update({ driver_id: null }).eq('driver_id', id);
    await supabase.from('buses').update({ conductor_id: null }).eq('conductor_id', id);
    await supabase.from('bus_locations').update({ employee_id: null }).eq('employee_id', id);
    await supabase.from('bookings').update({ payment_confirmed_by: null }).eq('payment_confirmed_by', id);
    await supabase.from('discount_verifications').update({ verified_by: null }).eq('verified_by', id);
    const { data: userBookings } = await supabase
      .from('bookings')
      .select('id')
      .eq('user_id', id);
    const bookingIds = (userBookings || []).map(b => b.id);
    if (bookingIds.length > 0) {
      await supabase.from('refund_requests').delete().in('booking_id', bookingIds);
    }

    await supabase.from('bookings').delete().eq('user_id', id);
    await supabase.from('feedbacks').delete().eq('user_id', id);
    await supabase.from('reports').delete().eq('employee_id', id);
    await supabase.from('discount_verifications').delete().eq('user_id', id);
    await supabase.from('notifications').delete().eq('recipient_id', id);
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;
    if (supabaseAdmin) {
      const { error: authDeleteErr } = await supabaseAdmin.auth.admin.deleteUser(id);
      if (authDeleteErr && !String(authDeleteErr.message || '').toLowerCase().includes('not found')) {
        console.warn('Failed to delete auth user:', authDeleteErr.message);
        return res.json({
          message: `User ${user.username || user.email} deleted from database, but auth account cleanup failed`,
          authWarning: authDeleteErr.message
        });
      }
    } else {
      console.warn('supabaseAdmin not configured — auth account not deleted, email may remain blocked for re-signup');
    }

    res.json({ message: `User ${user.username || user.email} and all related data deleted permanently` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm employee account
app.put('/api/admin/employee/:id/confirm', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ status: 'active' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get employee by ID
app.get('/api/admin/employee/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, email, role, profile, status, assigned_bus_id')
      .eq('id', req.params.id)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (error) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Employee Management (Admin) ---
// Create new employee account
app.post('/api/admin/employee/create', async (req, res) => {
  try {
    const {
      fullName,
      phone,
      role, // 'driver' or 'conductor'
      email, // Employee's real email
      password, // Employee's password
      busId // Optional: assign to bus immediately
    } = req.body;

    // Validate required fields
    if (!fullName || !phone || !role || !email || !password) {
      return res.status(400).json({
        error: 'Missing required fields: fullName, phone, role, email, password'
      });
    }

    // Validate role
    if (!['driver', 'conductor', 'employee'].includes(role)) {
      return res.status(400).json({
        error: 'Role must be "driver", "conductor", or "employee"'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email format'
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase service role not configured' });
    }

    // Check if email already exists (use admin client to bypass RLS)
    const { data: existingEmployees, error: existingErr } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('email', email);
    if (existingErr) throw existingErr;
    if (Array.isArray(existingEmployees) && existingEmployees.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const { data: authAdminData, error: authAdminError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: email.split('@')[0], role }
    });
    if (authAdminError) throw authAdminError;
    const newUserId = authAdminData.user && authAdminData.user.id ? authAdminData.user.id : null;
    if (!newUserId) return res.status(500).json({ error: 'Failed to create auth user' });

    // NOTE: creating the auth user above fires the `on_auth_user_created` DB trigger,
    // which auto-inserts a row into public.users with role='client' (id = newUserId).
    // We must UPSERT here (not plain insert) or this call fails with a duplicate-key
    // error on users_pkey, which the catch block below then mis-reports as
    // "email already exists" — and the trigger's role='client' row is left in place
    // instead of the intended role.
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: newUserId,
        username: email.split('@')[0],
        email,
        role,
        employee_id: null,
        assigned_bus_id: busId || null,
        profile: {
          fullName,
          phone,
          position: role,
          created_date: new Date().toISOString()
        },
        status: 'pending'
      }, { onConflict: 'id' })
      .select()
      .single();
    if (userError) throw userError;

    if (busId && ['driver', 'conductor'].includes(role)) {
      const updateField = role === 'driver' ? 'driver_id' : 'conductor_id';
      await supabaseAdmin
        .from('buses')
        .update({ [updateField]: userData.id })
        .eq('id', busId);
    }

    res.status(201).json({
      employee: userData,
      credentials: {
        email,
        password,
        message: "Employee can login with their email and password"
      }
    });
  } catch (error) {
    const msg = (error && error.message ? String(error.message).toLowerCase() : '');
    if (msg.includes('rate limit')) {
      return res.status(429).json({ error: 'email rate limit exceeded' });
    }
    if (msg.includes('duplicate key') || msg.includes('already exists')) {
      return res.status(409).json({ error: 'email already exists' });
    }
    return res.status(500).json({ error: error.message });
  }
});

// Employee login with Email and Password
app.post('/api/auth/employee-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // Check if user exists and is an employee
    const { data: employee, error: empError } = await supabase
      .from('users')
      .select('id, email, role, assigned_bus_id, status, profile, username')
      .eq('email', email)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (empError) {
      console.log('Employee lookup error:', empError);
      return res.status(404).json({ error: 'Employee not found' });
    }

    console.log('Found employee:', { email: employee.email, role: employee.role, status: employee.status });

    if (employee.status !== 'active') {
      return res.status(403).json({ error: 'Employee account is not active' });
    }

    // Login with email using Supabase auth
    console.log('Attempting login with email:', employee.email);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: employee.email,
      password
    });

    if (error) {
      console.log('Supabase auth error:', error);
      return res.status(401).json({
        error: 'Invalid credentials',
        debug: error.message
      });
    }

    res.json({
      success: true,
      session: data.session,
      employee: {
        id: data.user.id,
        email: employee.email,
        username: employee.username,
        role: employee.role,
        assignedBusId: employee.assigned_bus_id,
        profile: {
          fullName: employee.profile?.fullName,
          phone: employee.profile?.phone,
          position: employee.profile?.position
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// Get employee's assigned bus info
app.get('/api/employee/my-bus', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Employee email is required' });
    }

    const { data: employee, error: empError } = await supabase
      .from('users')
      .select(`
        assigned_bus_id,
        role,
        bus:assigned_bus_id(
          id,
          bus_number,
          total_seats,
          available_seats,
          current_location,
          status,
          driver_id,
          conductor_id,
          departure_status,
          scheduled_departure_time,
          actual_departure_time,
          departure_status_note,
          driver:driver_id(id, username, email, profile),
          conductor:conductor_id(id, username, email, profile),
          route:route_id(name, start_terminal_id, end_terminal_id)
        )
      `)
      .eq('email', email)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (empError) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    if (!employee.assigned_bus_id) {
      return res.json({ message: 'No bus assigned', bus: null });
    }

    let startName = null;
    let endName = null;
    const route = employee.bus?.route || null;
    if (route && (route.start_terminal_id || route.end_terminal_id)) {
      const ids = [route.start_terminal_id, route.end_terminal_id].filter(Boolean);
      const { data: terminals } = await supabase
        .from('terminals')
        .select('id, name, lat, lng, address, formatted_address')
        .in('id', ids);
      if (terminals && terminals.length) {
        const map = new Map(terminals.map(t => [t.id, t]));
        startName = map.get(route.start_terminal_id)?.name || null;
        endName = map.get(route.end_terminal_id)?.name || null;
        route.start_terminal = map.get(route.start_terminal_id) || null;
        route.end_terminal = map.get(route.end_terminal_id) || null;
      }
    }

    const liveLocation = employee.assigned_bus_id
      ? latestLocationsByBusId.get(employee.assigned_bus_id)
      : null;

    const bus = employee.bus ? {
      ...employee.bus,
      current_location: normalizeLatLng(liveLocation) || employee.bus.current_location,
      route: route ? {
        ...route,
        start_terminal_name: startName,
        end_terminal_name: endName
      } : null
    } : null;

    res.json({
      role: employee.role,
      bus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign employee to bus
app.put('/api/admin/employee/assign-bus', async (req, res) => {
  try {
    const { busId, email } = req.body;

    if (!busId || !email) {
      return res.status(400).json({ error: 'Bus ID and employee email are required' });
    }

    // Get employee details
    const { data: employee, error: empError } = await supabase
      .from('users')
      .select('id, role, username, profile, status')
      .eq('email', email)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (empError) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Check if employee is active
    if (employee.status !== 'active') {
      return res.status(403).json({ error: 'Employee account must be active before assignment' });
    }

    // Update user's assigned bus
    await supabase
      .from('users')
      .update({ assigned_bus_id: busId })
      .eq('email', email);

    let updatedBus = null;
    if (['driver', 'conductor'].includes(employee.role)) {
      // Update bus crew assignment only for roles with dedicated bus columns.
      const updateField = employee.role === 'driver' ? 'driver_id' : 'conductor_id';
      const { data: busData, error: busError } = await supabase
        .from('buses')
        .update({ [updateField]: employee.id })
        .eq('id', busId)
        .select()
        .single();

      if (busError) throw busError;
      updatedBus = busData;
    } else {
      const { data: busData, error: busError } = await supabase
        .from('buses')
        .select()
        .eq('id', busId)
        .single();

      if (busError) throw busError;
      updatedBus = busData;
    }

    res.json({
      message: `${employee.role} ${employee.profile?.fullName || employee.username} assigned to bus successfully`,
      bus: updatedBus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Feedback Management (Admin) ---
// Get all feedback submissions
app.get('/api/admin/feedbacks', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id,
        rating,
        comment,
        created_at,
        user:user_id(id, username, email, profile),
        bus:bus_id(id, bus_number, route_id, route:route_id(name))
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feedback by bus ID
app.get('/api/admin/feedbacks/bus/:busId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id,
        rating,
        comment,
        created_at,
        user:user_id(id, username, email, profile)
      `)
      .eq('bus_id', req.params.busId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feedback statistics
app.get('/api/admin/feedbacks/stats', async (req, res) => {
  try {
    // Get overall feedback stats
    const { data: allFeedbacks, error: feedbackError } = await supabase
      .from('feedbacks')
      .select('rating, bus_id');

    if (feedbackError) throw feedbackError;

    // Calculate statistics
    const totalFeedbacks = allFeedbacks.length;
    const averageRating = totalFeedbacks > 0
      ? (allFeedbacks.reduce((sum, feedback) => sum + feedback.rating, 0) / totalFeedbacks).toFixed(2)
      : 0;

    // Rating distribution
    const ratingDistribution = {
      1: allFeedbacks.filter(f => f.rating === 1).length,
      2: allFeedbacks.filter(f => f.rating === 2).length,
      3: allFeedbacks.filter(f => f.rating === 3).length,
      4: allFeedbacks.filter(f => f.rating === 4).length,
      5: allFeedbacks.filter(f => f.rating === 5).length
    };

    // Bus-wise feedback count
    const busFeedbackCount = allFeedbacks.reduce((acc, feedback) => {
      acc[feedback.bus_id] = (acc[feedback.bus_id] || 0) + 1;
      return acc;
    }, {});

    const stats = {
      totalFeedbacks,
      averageRating: parseFloat(averageRating),
      ratingDistribution,
      busFeedbackCount
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feedback by user ID
app.get('/api/admin/feedbacks/user/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id,
        rating,
        comment,
        created_at,
        bus:bus_id(id, bus_number, route_id, route:route_id(name))
      `)
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: delete a feedback by ID
app.delete('/api/admin/feedback/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: fb, error: checkErr } = await supabase
      .from('feedbacks')
      .select('id')
      .eq('id', id)
      .single();
    if (checkErr || !fb) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    const { error } = await supabase
      .from('feedbacks')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Feedback deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
// Render/Proxies
app.enable('trust proxy');

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// Tune HTTP server timeouts for long-lived SSE connections
try {
  server.requestTimeout = 0; // Disable per-request timeout
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
} catch (_) {
  // Best-effort only
}

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  
  // Cleanup all notification channels
  notificationChannels.forEach((channel, userId) => {
    cleanupNotificationChannel(userId);
  });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🔄 SIGINT received, shutting down gracefully...');
  
  // Cleanup all notification channels
  notificationChannels.forEach((channel, userId) => {
    cleanupNotificationChannel(userId);
  });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Employees only receive passengers for their assigned bus and selected trip
// date. This replaces client-side filtering of every passenger record.
app.get('/api/employee/bookings', async (req, res) => {
  try {
    const { employeeId, travelDate } = req.query;
    if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
    const { data: employee, error: employeeError } = await supabase
      .from('users').select('assigned_bus_id').eq('id', employeeId).single();
    if (employeeError || !employee?.assigned_bus_id) {
      return res.status(403).json({ error: 'No bus is assigned to this employee' });
    }
    const day = new Date(travelDate || new Date().toISOString());
    if (Number.isNaN(day.getTime())) return res.status(400).json({ error: 'Invalid travelDate' });
    day.setHours(0, 0, 0, 0);
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, user_id, bus_id, status, payment_method, payment_status, booking_type, seat_assignment,
        seats, amount, travel_date, created_at, receipt_sent, pickup_address, pickup_lat, pickup_lng,
        pickup_location_source, bus:bus_id(bus_number, route:route_id(name)), user:user_id(username, email, profile)
      `)
      .eq('bus_id', employee.assigned_bus_id)
      .gte('travel_date', day.toISOString())
      .lt('travel_date', nextDay.toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/employee/booking/:id/seat-assignment', async (req, res) => {
  try {
    const { employeeId, seat_assignment, seat_number, seat_numbers, standing_count } = req.body || {};
    if (!employeeId || !['seat', 'standing'].includes(seat_assignment)) {
      return res.status(400).json({ error: 'employeeId and seat_assignment (seat or standing) are required' });
    }
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id, bus_id, status, booking_type, seat_assignment, travel_date, seats, standing_count')
      .eq('id', req.params.id)
      .single();
    if (bookingError || !booking) return res.status(404).json({ error: 'Pickup request not found' });
    if (booking.booking_type !== 'pickup_request' || !['pending', 'confirmed'].includes(booking.status)) {
      return res.status(409).json({ error: 'Only active pickup requests can be assigned' });
    }
    const { data: employee, error: employeeError } = await supabase
      .from('users').select('assigned_bus_id').eq('id', employeeId).single();
    if (employeeError || employee?.assigned_bus_id !== booking.bus_id) {
      return res.status(403).json({ error: 'You are not assigned to this bus' });
    }
    let resolvedSeatNumbers = [];
    const standingCount = seat_assignment === 'standing' ? Number(standing_count || 1) : 0;
    if (!Number.isInteger(standingCount) || standingCount < 0 || standingCount > 4) {
      return res.status(400).json({ error: 'standing_count must be between 1 and 4' });
    }
    if (seat_assignment === 'seat') {
      const requestedSeats = Array.isArray(seat_numbers) && seat_numbers.length > 0
        ? seat_numbers.map(Number)
        : [Number(seat_number)];
      const uniqueSeats = [...new Set(requestedSeats)];
      if (uniqueSeats.length === 0 || uniqueSeats.some((seat) => !Number.isInteger(seat) || seat < 1)) {
        return res.status(400).json({ error: 'Choose one or more valid seat numbers' });
      }
      const bus = await syncBusAvailability(booking.bus_id);
      if (uniqueSeats.some((seat) => seat > Number(bus.total_seats || 0))) {
        return res.status(400).json({ error: 'One or more seat numbers are outside this bus capacity' });
      }
      const existingSeats = Array.isArray(booking.seats) ? booking.seats.map(Number) : [];
      const seatDelta = uniqueSeats.length - existingSeats.length;
      if (seatDelta > 0 && bus.available_seats < seatDelta) {
        return res.status(409).json({ error: 'No seats available; assign standing instead' });
      }
      const conflicts = await findSeatConflicts(booking.bus_id, booking.travel_date, uniqueSeats);
      const unavailableSeats = conflicts.filter((seat) => !existingSeats.includes(Number(seat)));
      if (unavailableSeats.length > 0) {
        return res.status(409).json({ error: `Seat(s) already assigned: ${unavailableSeats.join(', ')}` });
      }
      resolvedSeatNumbers = uniqueSeats;
    }
    if (seat_assignment === 'standing') {
      const bus = await syncBusAvailability(booking.bus_id);
      const existingStanding = booking.seat_assignment === 'standing'
        ? Math.max(1, Number(booking.standing_count || 0))
        : 0;
      const standingDelta = standingCount - existingStanding;
      if (standingDelta > 0 && Number(bus.available_standing || 0) < standingDelta) {
        return res.status(409).json({ error: 'No standing slots are available on this bus' });
      }
    }
    const { data: updated, error: updateError } = await supabase
      .from('bookings')
      .update({
        seat_assignment,
        ...(seat_assignment === 'seat' ? { seats: resolvedSeatNumbers } : { seats: [] }),
        standing_count: standingCount,
      })
      .eq('id', req.params.id)
      .select(`*, bus:bus_id(bus_number, route:route_id(name)), user:user_id(username, email, profile)`)
      .single();
    if (updateError) throw updateError;
    await syncBusAvailability(booking.bus_id);
    res.json({ booking: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pickup requests have no predefined route fare. The assigned crew records the
// fare after assessing the passenger's actual pickup point.
app.put('/api/employee/booking/:id/fare', async (req, res) => {
  try {
    const { employeeId, amount } = req.body || {};
    const fare = Number(amount);
    if (!employeeId || !Number.isFinite(fare) || fare < 0) {
      return res.status(400).json({ error: 'employeeId and a non-negative fare amount are required' });
    }
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id, bus_id, booking_type, status')
      .eq('id', req.params.id)
      .single();
    if (bookingError || !booking) return res.status(404).json({ error: 'Pickup request not found' });
    if (booking.booking_type !== 'pickup_request' || !['pending', 'confirmed', 'boarded'].includes(booking.status)) {
      return res.status(409).json({ error: 'Fare can only be set for an active pickup request' });
    }
    const { data: employee, error: employeeError } = await supabase
      .from('users').select('assigned_bus_id').eq('id', employeeId).single();
    if (employeeError || employee?.assigned_bus_id !== booking.bus_id) {
      return res.status(403).json({ error: 'You are not assigned to this bus' });
    }
    const { data: updated, error: updateError } = await supabase
      .from('bookings')
      .update({ amount: Number(fare.toFixed(2)) })
      .eq('id', req.params.id)
      .select(`*, bus:bus_id(bus_number, route:route_id(name)), user:user_id(username, email, profile)`)
      .single();
    if (updateError) throw updateError;
    res.json({ booking: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// “Pick Up Me” is intentionally not a booking: it has no fare and reserves
// no capacity until the assigned crew chooses a seat or standing status.
app.post('/api/client/pickup-request', async (req, res) => {
  try {
    const { userId, busId, travel_date, date, email } = req.body || {};
    if (!userId || !busId) {
      return res.status(400).json({ error: 'userId and busId are required' });
    }
    const travelDate = travel_date || date || new Date().toISOString();
    const { data: existing, error: existingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('user_id', userId)
      .eq('bus_id', busId)
      .eq('booking_type', 'pickup_request')
      .in('status', ['pending', 'confirmed', 'boarded'])
      .order('created_at', { ascending: false })
      .limit(1);
    if (existingError) throw existingError;
    if (existing?.[0]) return res.status(200).json(existing[0]);

    const { data: request, error } = await supabase
      .from('bookings')
      .insert({
        user_id: userId,
        bus_id: busId,
        status: 'pending',
        payment_method: 'cash',
        payment_status: 'pending',
        booking_type: 'pickup_request',
        seat_assignment: 'unassigned',
        seats: [],
        amount: 0,
        travel_date: travelDate,
        email: email || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(request);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
