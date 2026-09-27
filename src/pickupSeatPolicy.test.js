const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { validateSeats, priorityCategory } = require('./seatPolicy');
const { seatErrorStatus } = require('./seatPolicyService');
const source = fs.readFileSync(require.resolve('./server'), 'utf8');
const start = source.indexOf("app.put('/api/employee/booking/:id/seat-assignment'");
const end = source.indexOf('// Pickup requests have no predefined route fare.', start);

function harness({ assigned = true, existing = [], otherPrioritySeat = false } = {}) {
  let handler, payload;
  const booking = { id:'booking', user_id:'passenger', bus_id:'bus', trip_id:'trip', status:'pending', booking_type:'pickup_request', seats:existing, travel_date:'2026-10-01', seat_assignment:'seat' };
  const query = {
    select() { return this; }, eq() { return this; }, update(data) { payload=data; return this; },
    single: async () => ({ data:{ ...booking, ...payload } }),
  };
  vm.runInNewContext(source.slice(start,end), {
    app:{ put:(_, fn)=>{ handler=fn; } }, supabaseAdmin:{ from:()=>query },
    seatPolicy:{
      actor:async()=>({ id:'conductor' }),
      conductor:async()=>{ if (!assigned) throw Object.assign(new Error('Not assigned'),{status:403}); },
      context:async()=>({otherPrioritySeat}),
    }, validateSeats, priorityCategory, seatErrorStatus,
    getTripAvailability:async()=>({total_seats:40,available_seats:40,available_standing:4}),
    findSeatConflicts:async()=>[], syncBusAvailability:async()=>{},
  });
  return {
    get payload() { return payload; },
    async call(body) {
      const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
      await handler({params:{id:'booking'},body:{employeeId:'conductor',seat_assignment:'seat',...body}},res);
      return res;
    },
  };
}

test('physical ID confirmation records trusted conductor and category without online approval', async()=>{
  const h=harness();
  const r=await h.call({seat_numbers:[5,9],passenger_category:'pwd',physical_id_confirmed:true,priority_verified_by:'forged'});
  assert.equal(r.code,200); assert.equal(h.payload.priority_verified_by,'conductor');
  assert.equal(h.payload.priority_category,'pwd'); assert.ok(Date.parse(h.payload.priority_verified_at));
  assert.equal(h.payload.amount,undefined);
});
for(const body of [
  {seat_numbers:[5],passenger_category:'pwd'},
  {seat_numbers:[5],passenger_category:'senior_citizen',physical_id_confirmed:true},
  {seat_numbers:[5,6],passenger_category:'pwd',physical_id_confirmed:true},
  {seat_numbers:[5],passenger_category:'pwd',physical_id_confirmed:true,employeeId:'forged'},
]) test(`reject invalid pickup assignment ${JSON.stringify(body)}`,async()=>{
  const h=harness(); assert.ok((await h.call(body)).code>=400); assert.equal(h.payload,undefined);
});
test('conductor must be assigned to the bus',async()=>{
  const h=harness({assigned:false}); assert.equal((await h.call({seat_numbers:[9]})).code,403); assert.equal(h.payload,undefined);
});
test('regular seats need no physical ID and clear current confirmation',async()=>{
  const h=harness(); assert.equal((await h.call({seat_numbers:[9,10]})).code,200); assert.equal(h.payload.priority_category,null);
});
test('legacy exclusive seats can be retained but category changes require fresh confirmation',async()=>{
  const h=harness({existing:[1,2]}); assert.equal((await h.call({seat_numbers:[1,2,9]})).code,200);
  const moving=harness({existing:[1]}); assert.equal((await moving.call({seat_numbers:[5]})).code,400);
});
test('pickup cannot reserve another exclusive seat on a separate booking',async()=>{
  const h=harness({otherPrioritySeat:true});
  assert.equal((await h.call({seat_numbers:[5],passenger_category:'pwd',physical_id_confirmed:true})).code,409);
});
