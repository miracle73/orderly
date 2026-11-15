// One platform Paystack account (PAYSTACK_SECRET_KEY). Each business adds only its bank account; we create a
// Paystack subaccount for it so its share of every payment settles straight to that bank account.
const crypto = require('crypto');

const KEY = () => process.env.PAYSTACK_SECRET_KEY;

async function call(path, init = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init, headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.status) throw Object.assign(new Error(body.message || `Paystack ${res.status}`), { paystack: true });
  return body.data;
}

let banksCache;
async function listBanks() {
  if (!banksCache) {
    const data = await call('/bank?country=nigeria&currency=NGN&perPage=200');
    banksCache = data.filter(b => b.active !== false).map(b => ({ name: b.name, code: b.code }));  }
  return banksCache;
}

const resolveAccount = (accountNumber, bankCode) =>
  call(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);

// Creates or updates the business's subaccount; returns its code.
async function saveSubaccount(existingCode, { businessName, bankCode, accountNumber }) {
  const body = JSON.stringify({
    business_name: businessName, settlement_bank: bankCode, account_number: accountNumber,
    percentage_charge: Number(process.env.PLATFORM_FEE_PERCENT || 0),
  });
  const data = existingCode
    ? await call(`/subaccount/${existingCode}`, { method: 'PUT', body })
    : await call('/subaccount', { method: 'POST', body });
  return data.subaccount_code;
}

const initialize = ({ email, amountKobo, reference, metadata, subaccount }) => call('/transaction/initialize', {
  method: 'POST',
  body: JSON.stringify({
    email, amount: amountKobo, reference, metadata, currency: 'NGN',
    ...(subaccount ? { subaccount, bearer: 'subaccount' } : {}),
    ...(process.env.FRONTEND_URL ? { callback_url: `${process.env.FRONTEND_URL}/paid.html` } : {}),
  }),
});

// Server-side confirmation; never trust a webhook payload alone.
const verify = reference => call(`/transaction/verify/${encodeURIComponent(reference)}`);

function validSignature(rawBody, signature) {
  if (!signature || !rawBody) return false;
  const a = Buffer.from(crypto.createHmac('sha512', KEY()).update(rawBody).digest('hex'));
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { listBanks, resolveAccount, saveSubaccount, initialize, verify, validSignature };
