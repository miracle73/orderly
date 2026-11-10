// Paystack calls use each business's own secret key, so money settles directly into their account.
const crypto = require('crypto');

async function call(secretKey, path, init = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init, headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.status) throw new Error(`Paystack: ${body.message || res.status}`);
  return body.data;
}

const initialize = (secretKey, { email, amountKobo, reference, metadata }) => call(secretKey, '/transaction/initialize', {
  method: 'POST',
  body: JSON.stringify({
    email, amount: amountKobo, reference, metadata, currency: 'NGN',
    ...(process.env.FRONTEND_URL ? { callback_url: `${process.env.FRONTEND_URL}/paid.html` } : {}),
  }),
});

// Server-side confirmation; never trust a webhook payload alone.
const verify = (secretKey, reference) => call(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);

// Cheap authenticated call to check a key works before saving it.
const checkKey = secretKey => call(secretKey, '/transaction?perPage=1');

function validSignature(secretKey, rawBody, signature) {
  if (!signature || !rawBody) return false;
  const a = Buffer.from(crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex'));
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initialize, verify, checkKey, validSignature };
