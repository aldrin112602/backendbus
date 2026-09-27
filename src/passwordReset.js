const crypto = require('crypto');
const nodemailer = require('nodemailer');

function createGmailSender(env = process.env, createTransport = nodemailer.createTransport) {
  let transport;
  return async (email, code) => {
    if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) throw new Error('Email is not configured');
    transport ||= createTransport({
      service: 'gmail',
      auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    const result = await transport.sendMail({
      from: { name: 'AuroRide', address: env.EMAIL_USER },
      to: email,
      subject: 'Your AuroRide password reset code',
      text: `Your AuroRide password reset code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px"><h2>AuroRide Password Reset</h2><p>Use this code to reset your password:</p><p style="font-size:28px;letter-spacing:6px;color:#db2777;font-weight:bold">${code}</p><p>This code expires in 10 minutes. If you did not request this, ignore this email.</p></div>`,
    });
    if (!result.accepted?.some(address => String(address).toLowerCase() === email)) {
      throw new Error('Email was not accepted');
    }
  };
}

// State is intentionally local to one backend instance. Restarting requires a new OTP.
function createPasswordResetHandlers({ findUser, updatePassword, sendEmail, now = Date.now }) {
  const entries = new Map();
  const busy = new Set();
  const ttl = 10 * 60 * 1000;
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const fail = (res, status, error) => res.status(status).json({ error });
  const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const prune = () => {
    for (const [email, entry] of entries) if (now() >= entry.expiresAt) entries.delete(email);
  };
  const check = (email, code, res) => {
    const entry = entries.get(email);
    if (!entry || now() >= entry.expiresAt) {
      entries.delete(email);
      fail(res, 400, 'Code expired or unavailable. Request a new code.');
      return null;
    }
    if (entry.attempts >= 5) {
      fail(res, 429, 'Too many incorrect attempts. Request a new code.');
      return null;
    }
    const digest = crypto.createHash('sha256').update(typeof code === 'string' ? code : '').digest();
    if (!crypto.timingSafeEqual(digest, entry.digest)) {
      entry.attempts++;
      fail(res, entry.attempts >= 5 ? 429 : 400, entry.attempts >= 5
        ? 'Too many incorrect attempts. Request a new code.' : 'Invalid code. Please try again.');
      return null;
    }
    return entry;
  };

  return {
    async send(req, res) {
      const email = normalize(req.body?.email);
      if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
      prune();
      if (busy.has(email)) return fail(res, 429, 'A reset request is already in progress. Please wait.');
      const previous = entries.get(email);
      const retryAfter = previous ? Math.ceil((previous.sentAt + 60000 - now()) / 1000) : 0;
      if (retryAfter > 0) {
        res.set('Retry-After', String(retryAfter));
        return fail(res, 429, `Please wait ${retryAfter} seconds before requesting another code.`);
      }
      busy.add(email);
      try {
        const user = await findUser(email);
        if (!user) return fail(res, 404, 'User not found');
        const code = String(crypto.randomInt(100000, 1000000));
        await sendEmail(email, code);
        // Do not replace a working code until the replacement email is accepted.
        entries.set(email, {
          userId: user.id, digest: crypto.createHash('sha256').update(code).digest(),
          expiresAt: now() + ttl, sentAt: now(), attempts: 0, verified: false,
        });
        return res.json({ success: true, message: 'OTP sent', retryAfter: 60 });
      } catch {
        return fail(res, 503, 'Unable to send reset email. Please try again later.');
      } finally {
        busy.delete(email);
      }
    },
    async verify(req, res) {
      const email = normalize(req.body?.email);
      if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
      if (busy.has(email)) return fail(res, 409, 'A reset request is already in progress. Please wait.');
      const entry = check(email, req.body?.code, res);
      if (!entry) return;
      entry.verified = true;
      return res.json({ success: true, message: 'OTP verified' });
    },
    async update(req, res) {
      const email = normalize(req.body?.email);
      const newPassword = req.body?.newPassword;
      if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
      if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return fail(res, 400, 'Password must be at least 6 characters');
      }
      if (busy.has(email)) return fail(res, 409, 'A reset request is already in progress. Please wait.');
      const entry = check(email, req.body?.code, res);
      if (!entry) return;
      if (!entry.verified) return fail(res, 400, 'Verify your code before updating your password.');
      busy.add(email);
      try {
        await updatePassword(entry.userId, newPassword);
        entries.delete(email);
        return res.json({ success: true, message: 'Password updated' });
      } catch {
        return fail(res, 503, 'Unable to update password. Please try again.');
      } finally {
        busy.delete(email);
      }
    },
  };
}

module.exports = { createGmailSender, createPasswordResetHandlers };
