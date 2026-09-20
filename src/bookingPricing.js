const discountLabels = { student: 'Student', senior_citizen: 'Senior Citizen', pwd: 'PWD' };
const php = (value) => `₱${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function calculateBookingPrice(fare, count, verification) {
  if (!Number.isFinite(Number(fare)) || Number(fare) <= 0 || !Number.isInteger(count) || count < 1) {
    throw new Error('Invalid fare or passenger count');
  }
  const fareCents = Math.round(Number(fare) * 100);
  const subtotalCents = fareCents * count;
  const type = verification?.status === 'approved' && Object.hasOwn(discountLabels, verification.type) ? verification.type : null;
  const discountCents = type ? Math.round(subtotalCents * 0.2) : 0;
  return {
    fare_per_passenger: fareCents / 100, passenger_count: count,
    subtotal: subtotalCents / 100, discount_type: type,
    discount_percent: type ? 20 : 0, discount_amount: discountCents / 100,
    amount: (subtotalCents - discountCents) / 100,
  };
}

function receiptPricingRows(booking) {
  const fields = ['fare_per_passenger', 'passenger_count', 'subtotal', 'discount_percent', 'discount_amount'];
  if (fields.some((key) => booking[key] == null || !Number.isFinite(Number(booking[key])))) {
    return '<tr><td colspan="2" style="padding:12px 16px;font-size:12px;color:#6b7280;">Detailed fare breakdown unavailable.</td></tr>';
  }
  const rows = [
    ['Fare × passengers', `${php(booking.fare_per_passenger)} × ${Number(booking.passenger_count)}`],
    ['Subtotal', php(booking.subtotal)],
    [`${discountLabels[booking.discount_type] || 'Discount'} (${Number(booking.discount_percent)}%)`, `−${php(booking.discount_amount)}`],
  ];
  return rows.map(([label, value]) => `<tr><td style="padding:12px 16px;font-size:12px;">${label}</td><td style="padding:12px 16px;font-size:12px;">${value}</td></tr>`).join('');
}
module.exports = { calculateBookingPrice, receiptPricingRows };
