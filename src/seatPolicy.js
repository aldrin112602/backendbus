const ACTIVE = ['pending', 'confirmed', 'boarded'];
const categoryOf = seat => seat <= 4 ? 'senior_citizen' : seat <= 8 ? 'pwd' : 'regular';
const priorityCategory = value => ['senior_citizen', 'pwd'].includes(value) ? value : null;
const approvedCategory = verification => verification?.status === 'approved' ? priorityCategory(verification.type) : null;
const policyError = (message, status = 400) => Object.assign(new Error(message), { status });

function manilaDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw policyError('Choose a valid travel date.');
  const day = new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+08:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

function validateSeats({ seats, totalSeats, category, existingSeats = [], otherPrioritySeat = false }) {
  if (!Array.isArray(seats) || !seats.length || seats.some(n => !Number.isInteger(n) || n < 1 || n > totalSeats) || new Set(seats).size !== seats.length) {
    throw policyError('Choose valid, distinct seat numbers.');
  }
  const added = seats.filter(n => !existingSeats.includes(n));
  if (totalSeats < 8 && added.length) throw policyError('Seat booking is unavailable: this bus needs at least 8 seats.', 409);
  const priority = seats.filter(n => n <= 8);
  const addedPriority = added.filter(n => n <= 8);
  if (addedPriority.length) {
    if (priority.length > 1 || otherPrioritySeat) throw policyError('Only one exclusive seat per passenger account per trip is allowed.', 409);
    if (addedPriority.some(n => categoryOf(n) !== category)) {
      throw policyError('Seats 1–4 require senior eligibility; seats 5–8 require PWD eligibility.', 403);
    }
  }
}

function availability({ totalSeats, bookings, userId, category, editingBookingId }) {
  const others = bookings.filter(b => b.id !== editingBookingId);
  const occupied = new Set(others.flatMap(b => (b.seats || []).map(Number)));
  const keptSeats = (bookings.find(b => b.id === editingBookingId)?.seats || []).map(Number);
  const otherPrioritySeat = others.some(b => b.user_id === userId && (b.seats || []).some(n => Number(n) <= 8));
  const counts = { regular: 0, senior_citizen: 0, pwd: 0 };
  const seats = Array.from({ length: totalSeats }, (_, i) => {
    const number = i + 1;
    const seatCategory = categoryOf(number);
    const isOccupied = occupied.has(number);
    if (!isOccupied) counts[seatCategory]++;
    let reason = isOccupied ? 'Occupied' : null;
    if (!reason && !keptSeats.includes(number)) {
      if (totalSeats < 8) reason = 'Bus must have at least 8 seats.';
      else if (number <= 8 && otherPrioritySeat) reason = 'You already have an exclusive seat for this trip.';
      else if (number <= 8 && category !== seatCategory) reason = `Exclusive ${seatCategory === 'pwd' ? 'PWD' : 'senior'} seat. Eligibility required.`;
    }
    return { number, category: seatCategory, occupied: isOccupied, selectable: !reason, reason };
  });
  return { seats, availableByCategory: counts, eligibleCategory: category, otherPrioritySeat, seatBookingEnabled: totalSeats >= 8 };
}

module.exports = { ACTIVE, categoryOf, priorityCategory, approvedCategory, policyError, manilaDay, validateSeats, availability };
