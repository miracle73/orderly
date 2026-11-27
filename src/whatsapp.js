// Per-business WhatsApp assistant via the business's own Twilio account.
// The business pastes its Account SID + Auth Token + WhatsApp number; we verify them, point the number's
// incoming-message webhook at Orderly, and reply to customers with the same AI agent (TwiML response).
const crypto = require('crypto');
const { pool } = require('./store');
const auth = require('./auth');

const fail = m => Object.assign(new Error(m), { status: 400 });
const basic = (sid, token) => 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
const normal = n => '+' + String(n || '').replace(/\D/g, '');

async function twilio(sid, token, path, { method = 'GET', form } = {}) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    method, headers: { Authorization: basic(sid, token), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status === 401 ? 'Twilio did not accept those codes. Check the Account SID and Auth Token.' : (body.message || `Twilio error ${res.status}`));
  return body;
}

// Verifies credentials, saves them (token encrypted) and auto-configures the webhook when the number is on Twilio.
async function connect(bid, { accountSid, authToken, number }, webhookUrl) {
  const sid = String(accountSid || '').trim(), token = String(authToken || '').trim(), num = normal(number);
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw fail('The Account SID starts with "AC" and has 34 characters');
  if (token.length < 20) throw fail('Paste the full Auth Token');
  if (num.length < 11) throw fail('Enter your WhatsApp number with country code, e.g. +2348012345678');
  await twilio(sid, token, '.json');
  let auto = false;
  try {
    const { incoming_phone_numbers: nums = [] } = await twilio(sid, token, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(num)}`);
    if (nums[0]) { await twilio(sid, token, `/IncomingPhoneNumbers/${nums[0].sid}.json`, { method: 'POST', form: { SmsUrl: webhookUrl, SmsMethod: 'POST' } }); auto = true; }
  } catch (e) { console.error('twilio webhook auto-config', e.message); }
  await pool.query('UPDATE businesses SET wa_sid=$1, wa_token_enc=$2, wa_number=$3 WHERE id=$4', [sid, auth.encrypt(token), num, bid]);
  return { autoConfigured: auto };
}
const disconnect = bid => pool.query('UPDATE businesses SET wa_sid=NULL, wa_token_enc=NULL, wa_number=NULL WHERE id=$1', [bid]);

// Twilio request signature: HMAC-SHA1(authToken, url + sorted(key+value)), base64.
function validSignature(token, url, params, signature) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const a = Buffer.from(crypto.createHmac('sha1', token).update(data).digest('base64'));
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One open order per customer: reuse an unfinished order from the last 24h, otherwise start a fresh conversation.
async function conversationId(bid, from) {
  const prefix = `wa_${bid}_${String(from).replace(/\D/g, '')}_`;
  const { rows: [o] } = await pool.query(
    `SELECT call_id FROM orders WHERE call_id LIKE $1 AND status IN ('building','confirmed','awaiting_payment') AND updated_at > now() - interval '24 hours'
     ORDER BY updated_at DESC LIMIT 1`, [prefix + '%']);
  if (o) return o.call_id;
  const { rows: [t] } = await pool.query(`SELECT call_id FROM transcripts WHERE call_id LIKE $1 AND created_at > now() - interval '2 hours' ORDER BY created_at DESC LIMIT 1`, [prefix + '%']);
  return t ? t.call_id : prefix + Date.now();
}

const twiml = text => `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${String(text).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</Message></Response>`;

module.exports = { connect, disconnect, validSignature, conversationId, twiml };
