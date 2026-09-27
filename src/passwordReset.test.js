const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPasswordResetHandlers, createGmailSender } = require('./passwordReset');

function setup(overrides = {}) {
  let time = 0;
  let latestCode;
  let updates = 0;
  const handlers = createPasswordResetHandlers({
    findUser: async () => ({ id: 'test-user' }),
    updatePassword: async (id, password) => {
      assert.equal(id, 'test-user');
      assert.equal(password, 'new-password');
      updates++;
    },
    sendEmail: async (email, code) => { latestCode = code; },
    now: () => time,
    ...overrides,
  });
  return {
    get code() { return latestCode; },
    get updates() { return updates; },
    advance: ms => { time += ms; },
    async call(action, body = {}) {
      const res = { statusCode: 200, headers: {},
        status(n) { this.statusCode = n; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        json(value) { this.body = value; return this; },
      };
      await handlers[action]({ body: { email: ' Test@Example.com ', ...body } }, res);
      return res;
    },
  };
}

test('complete reset requires verification and is single use', async () => {
  const s = setup();
  assert.equal((await s.call('send')).body.success, true);
  assert.match(s.code, /^\d{6}$/);
  const body = { code: s.code, newPassword: 'new-password' };
  assert.equal((await s.call('update', body)).statusCode, 400);
  assert.equal((await s.call('verify', body)).body.success, true);
  assert.equal((await s.call('update', body)).body.success, true);
  assert.equal((await s.call('update', body)).statusCode, 400);
  assert.equal(s.updates, 1);
});

test('delivery errors never return success or create a usable code', async () => {
  const s = setup({ sendEmail: async () => { throw new Error('SMTP rejected / timeout'); } });
  assert.equal((await s.call('send')).statusCode, 503);
  assert.equal((await s.call('verify', { code: '123456' })).statusCode, 400);
  await assert.rejects(createGmailSender({})('test@example.com', '123456'));
});

test('resend cooldown and successful replacement require new verification', async () => {
  const s = setup();
  await s.call('send');
  await s.call('verify', { code: s.code });
  const blocked = await s.call('send');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  s.advance(60000);
  assert.equal((await s.call('send')).body.success, true);
  assert.equal((await s.call('update', { code: s.code, newPassword: 'new-password' })).statusCode, 400);
});

test('failed resend preserves previously delivered code', async () => {
  let code;
  let calls = 0;
  const s = setup({ sendEmail: async (_, value) => {
    if (calls++) throw new Error('SMTP timeout');
    code = value;
  } });
  await s.call('send');
  s.advance(60000);
  assert.equal((await s.call('send')).statusCode, 503);
  assert.equal((await s.call('verify', { code })).body.success, true);
});

test('codes expire at ten minutes, including after verification', async () => {
  const s = setup();
  await s.call('send');
  await s.call('verify', { code: s.code });
  s.advance(600000);
  assert.equal((await s.call('update', { code: s.code, newPassword: 'new-password' })).statusCode, 400);
  assert.equal(s.updates, 0);
});

test('five incorrect attempts across verify and update lock the code', async () => {
  const s = setup();
  await s.call('send');
  for (let i = 0; i < 5; i++) {
    const result = await s.call(i % 2 ? 'update' : 'verify', { code: '000000', newPassword: 'new-password' });
    assert.equal(result.statusCode, i === 4 ? 429 : 400);
  }
  assert.equal((await s.call('verify', { code: s.code })).statusCode, 429);
});

test('concurrent updates and resend cannot reuse a verified code', async () => {
  let release;
  const s = setup({ updatePassword: () => new Promise(resolve => { release = resolve; }) });
  await s.call('send');
  await s.call('verify', { code: s.code });
  s.advance(60000);
  const body = { code: s.code, newPassword: 'new-password' };
  const pending = s.call('update', body);
  assert.equal((await s.call('update', body)).statusCode, 409);
  assert.equal((await s.call('send')).statusCode, 429);
  release();
  assert.equal((await pending).body.success, true);
  assert.equal((await s.call('update', body)).statusCode, 400);
});

test('update failures allow retry without consuming code', async () => {
  let fail = true;
  const s = setup({ updatePassword: async () => { if (fail) throw new Error('Unavailable'); } });
  await s.call('send');
  await s.call('verify', { code: s.code });
  const body = { code: s.code, newPassword: 'new-password' };
  assert.equal((await s.call('update', body)).statusCode, 503);
  fail = false;
  assert.equal((await s.call('update', body)).body.success, true);
});

test('invalid email and unknown account never send email', async () => {
  const s = setup({ findUser: async () => null, sendEmail: async () => assert.fail('must not send') });
  assert.equal((await s.call('send', { email: 'bad\r\nheader' })).statusCode, 400);
  assert.equal((await s.call('send')).statusCode, 404);
});

test('Gmail sender uses configured credentials and requires recipient acceptance', async () => {
  let accepted = [];
  const sender = createGmailSender({ EMAIL_USER: 'sender@example.com', EMAIL_PASSWORD: 'test-only' }, config => {
    assert.equal(config.service, 'gmail');
    assert.equal(config.auth.user, 'sender@example.com');
    assert.ok(config.socketTimeout > 0);
    return { sendMail: async message => {
      assert.equal(message.from.address, 'sender@example.com');
      assert.equal(message.to, 'test@example.com');
      assert.match(message.text, /123456/);
      assert.match(message.html, /123456/);
      return { accepted };
    } };
  });
  await assert.rejects(sender('test@example.com', '123456'));
  accepted = ['test@example.com'];
  await sender('test@example.com', '123456');
});
