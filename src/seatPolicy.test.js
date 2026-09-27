const { test } = require('node:test');
const assert = require('node:assert/strict');
const { approvedCategory, validateSeats, availability, manilaDay } = require('./seatPolicy');
const { createSeatPolicyService } = require('./seatPolicyService');

for (const type of ['senior_citizen', 'pwd', 'student']) {
  for (const status of ['approved', 'pending', 'rejected']) {
    test(`${status} ${type}: correct exclusive-seat eligibility`, () => {
      const category = approvedCategory({ status, type });
      for (const [seat, matching] of [[1, 'senior_citizen'], [5, 'pwd'], [9, null]]) {
        const run = () => validateSeats({ seats: [seat], totalSeats: 40, category });
        if (seat === 9 || (status === 'approved' && type === matching)) assert.doesNotThrow(run);
        else assert.throws(run);
      }
    });
  }
}
test('group and existing-booking limits', () => {
  assert.doesNotThrow(() => validateSeats({ seats: [1,9,10,11], totalSeats: 40, category: 'senior_citizen' }));
  assert.throws(() => validateSeats({ seats: [1,2], totalSeats: 40, category: 'senior_citizen' }));
  assert.throws(() => validateSeats({ seats: [1], totalSeats: 40, category: 'senior_citizen', otherPrioritySeat: true }));
  assert.doesNotThrow(() => validateSeats({ seats: [1,2,9], existingSeats: [1,2], totalSeats: 40, category: null }));
  assert.throws(() => validateSeats({ seats: [1], totalSeats: 7, category: 'senior_citizen' }));
});
test('vacant exclusive seats are counted by category, not occupied', () => {
  const result = availability({ totalSeats: 12, bookings: [{ id:'a', user_id:'me', seats:[1,9] }], userId:'me', category:'senior_citizen' });
  assert.deepEqual(result.availableByCategory, { regular:3, senior_citizen:3, pwd:4 });
  assert.equal(result.otherPrioritySeat, true);
  assert.equal(result.seats[1].occupied, false);
  assert.equal(result.seats[1].selectable, false);
  assert.equal(result.seats[9].selectable, true);
});
test('Manila legacy date boundaries match UTC+8, independently of server timezone', () => {
  assert.deepEqual(manilaDay('2026-10-01T20:00:00Z'), { start:'2026-10-01T16:00:00.000Z', end:'2026-10-02T16:00:00.000Z' });
});
test('identity is derived from a validated bearer token', async () => {
  const service = createSeatPolicyService(null, { getUser: async token => ({ data: token === 'valid' ? { user: { id:'real' } } : null }) });
  await assert.rejects(service.actor({ headers:{} }), { status:401 });
  await assert.rejects(service.actor({ headers:{ authorization:'Bearer invalid' } }), { status:401 });
  assert.equal((await service.actor({ headers:{ authorization:'Bearer valid' }, body:{ userId:'forged' } })).id, 'real');
});
test('only an active assigned conductor can confirm physical ID', async () => {
  let user = { role:'conductor', status:'active', assigned_bus_id:'bus' };
  const db = { from:()=>({ select(){return this;},eq(){return this;},single:async()=>({data:user}) }) };
  const service = createSeatPolicyService(db, {});
  await service.conductor('employee','bus');
  await assert.rejects(service.conductor('employee','another-bus'), {status:403});
  user.role='driver';
  await assert.rejects(service.conductor('employee','bus'), {status:403});
  user.role='conductor';user.status='suspended';
  await assert.rejects(service.conductor('employee','bus'), {status:403});
});
