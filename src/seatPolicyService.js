const { ACTIVE, approvedCategory, policyError, manilaDay, availability } = require('./seatPolicy');

function createSeatPolicyService(db, auth) {
  async function actor(req, required = true) {
    const token = (req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) { if (required) throw policyError('Please sign in again.', 401); return null; }
    const { data, error } = await auth.getUser(token);
    if (error || !data?.user) throw policyError('Please sign in again.', 401);
    return data.user;
  }
  async function conductor(userId, busId) {
    const { data, error } = await db.from('users').select('role,status,profile,assigned_bus_id').eq('id', userId).single();
    const isConductor = data?.role === 'conductor' || (data?.role === 'employee' && data?.profile?.position?.toLowerCase() === 'conductor');
    if (error || !isConductor || data.status !== 'active' || data.assigned_bus_id !== busId) {
      throw policyError('Only the assigned conductor can assign pickup seats.', 403);
    }
    return data;
  }
  async function context(busId, date, tripId, userId, editingBookingId) {
    if (!db) throw policyError('Seat service is unavailable.', 503);
    const { data: bus, error: busError } = await db.from('buses').select('id,total_seats').eq('id', busId).single();
    if (busError || !bus) throw policyError('Bus not found.', 404);
    let query = db.from('bookings').select('id,user_id,seats,booking_type').eq('bus_id', busId).in('status', ACTIVE);
    if (tripId) {
      const { data: trip, error } = await db.from('bus_trips').select('id,bus_id').eq('id', tripId).single();
      if (error || trip?.bus_id !== busId) throw policyError('Invalid trip for this bus.');
      query = query.eq('trip_id', tripId);
    } else {
      const day = manilaDay(date);
      query = query.is('trip_id', null).gte('travel_date', day.start).lt('travel_date', day.end);
    }
    const { data: bookings, error } = await query;
    if (error) throw error;
    let category = null;
    if (userId && !editingBookingId) {
      const result = await db.from('discount_verifications').select('type,status').eq('user_id', userId).eq('status', 'approved').maybeSingle();
      if (result.error) throw result.error;
      category = approvedCategory(result.data);
    }
    return { bus, bookings, category, ...availability({ totalSeats: bus.total_seats, bookings, userId, category, editingBookingId }) };
  }
  return { actor, conductor, context };
}

function seatErrorStatus(error) {
  return error.status || (['23514', '23505'].includes(error.code) ? 409 : error.code === '42501' ? 403 : 500);
}
module.exports = { createSeatPolicyService, seatErrorStatus };
