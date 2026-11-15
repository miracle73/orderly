require('dotenv').config();
const path = require('path');
const express = require('express');
const store = require('./store');
const paystack = require('./paystack');
const sms = require('./sms');
const llm = require('./llm');
const vapi = require('./vapi');
const auth = require('./auth');
const email = require('./email');
const crypto = require('crypto');
const { runTool } = require('./tools');
const { runAgent } = require('./agent');

const app = express();
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// CORS for the Vercel frontend.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.FRONTEND_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) app.use(express.static(path.join(__dirname, '../public')));

const agentDeps = { llm: llm.chat, runTool, getOrder: store.getOrder };
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
});
const httpError = (status, message) => Object.assign(new Error(message), { status });
const baseUrl = req => process.env.PUBLIC_URL || `https://${req.get('host')}`;
const kobo = naira => Math.round(Number(naira) * 100);

async function businessOr404(id) {
  const b = await store.getBusiness(id);
  if (!b) throw httpError(404, 'Business not found');
  return b;
}

const profile = (b, req) => ({
  id: b.id, name: b.name, email: b.email, phoneNumber: b.phone_number,
  voiceReady: !!b.vapi_assistant_id, emailVerified: b.email_verified,
  payout: b.paystack_subaccount ? { bankName: b.bank_name, accountName: b.account_name, accountLast4: String(b.account_number).slice(-4) } : null,
});

// ---------- Email verification ----------
const VERIFY_TTL_MS = 24 * 3600 * 1000;
async function sendVerify(b, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await store.updateBusiness(b.id, { verify_token_hash: sha256(token), verify_sent_at: new Date() });
  const origin = process.env.FRONTEND_URL || req.get('origin') || baseUrl(req);
  await email.sendVerification(b.email, b.name, `${origin}/verify.html?token=${token}`);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Auth ----------
app.post('/api/auth/signup', wrap(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || String(password || '').length < 8) {
    throw httpError(400, 'Business name, valid email and a password of 8+ characters are required');
  }
  if (await store.getBusinessByEmail(email)) throw httpError(409, 'An account with this email already exists');
  const b = await store.createBusiness({ name: name.trim(), email, passwordHash: auth.hashPassword(password) });
  try {
    await store.updateBusiness(b.id, { vapi_assistant_id: await vapi.syncAssistant(b, baseUrl(req)) });
  } catch (e) { console.error('assistant create failed', e.message); }
  try { await sendVerify(b, req); } catch (e) { console.error('verification email failed', e.message); }
  res.json({ verifyRequired: true, email: b.email });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const b = await store.getBusinessByEmail(email || '');
  if (!b || !auth.checkPassword(String(password || ''), b.password_hash)) throw httpError(401, 'Wrong email or password');
  if (!b.email_verified) return res.status(403).json({ error: 'Please verify your email first. Check your inbox.', verifyRequired: true });
  res.json({ token: auth.signToken({ bid: b.id }) });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  const token = String(req.body?.token || '');
  const b = token && await store.getBusinessByVerifyHash(sha256(token));
  if (!b || Date.now() - new Date(b.verify_sent_at).getTime() > VERIFY_TTL_MS) throw httpError(400, 'This link is invalid or has expired. Request a new one.');
  await store.updateBusiness(b.id, { email_verified: true, verify_token_hash: null });
  await email.sendWelcome(b);
  res.json({ token: auth.signToken({ bid: b.id }) });
}));

// Always answers OK so it can't be used to discover which emails have accounts.
app.post('/api/auth/resend-verification', wrap(async (req, res) => {
  const b = await store.getBusinessByEmail(String(req.body?.email || ''));
  if (b && !b.email_verified && (!b.verify_sent_at || Date.now() - new Date(b.verify_sent_at).getTime() > 60000)) {
    try { await sendVerify(b, req); } catch (e) { console.error('verification email failed', e.message); }
  }
  res.json({ ok: true });
}));

app.get('/api/banks', wrap(async (_req, res) => res.json(await paystack.listBanks())));

// ---------- Business (logged in) ----------
const me = express.Router();
me.use(auth.requireAuth);

me.get('/', wrap(async (req, res) => res.json(profile(await businessOr404(req.businessId), req))));

me.patch('/', wrap(async (req, res) => {
  const { name } = req.body || {};
  const fields = {};
  if (name?.trim()) fields.name = name.trim();
  await store.updateBusiness(req.businessId, fields);
  const b = await businessOr404(req.businessId);
  if (fields.name) await vapi.syncAssistant(b, baseUrl(req)).catch(e => console.error(e.message));
  res.json(profile(b, req));
}));

// Payout bank account: verified with Paystack, then saved as this business's subaccount.
me.post('/payout', wrap(async (req, res) => {
  const { bankCode, accountNumber } = req.body || {};
  if (!/^\d{10}$/.test(String(accountNumber || ''))) throw httpError(400, 'Account number must be 10 digits');
  const bank = (await paystack.listBanks()).find(x => x.code === bankCode);
  if (!bank) throw httpError(400, 'Choose your bank');
  let b = await businessOr404(req.businessId);
  try {
    const { account_name } = await paystack.resolveAccount(accountNumber, bankCode);
    const code = await paystack.saveSubaccount(b.paystack_subaccount, { businessName: b.name, bankCode, accountNumber });
    await store.updateBusiness(b.id, { bank_code: bankCode, bank_name: bank.name, account_number: accountNumber, account_name, paystack_subaccount: code });
  } catch (e) {
    if (e.paystack) throw httpError(400, `Couldn't verify that account: ${e.message}`);
    throw e;
  }
  res.json(profile(await businessOr404(b.id), req));
}));

me.post('/voice/sync',wrap(async (req, res) => {
  const b = await businessOr404(req.businessId);
  try { await store.updateBusiness(b.id, { vapi_assistant_id: await vapi.syncAssistant(b, baseUrl(req)) }); }
  catch (e) { throw httpError(502, e.message); }
  res.json(profile(await businessOr404(b.id), req));
}));

me.post('/phone-number', wrap(async (req, res) => {
  let b = await businessOr404(req.businessId);
  if (b.vapi_phone_number_id) throw httpError(409, 'This business already has a phone number');
  try {
    if (!b.vapi_assistant_id) {
      await store.updateBusiness(b.id, { vapi_assistant_id: await vapi.syncAssistant(b, baseUrl(req)) });
      b = await businessOr404(b.id);
    }
    const { id, number } = await vapi.provisionNumber(b, req.body || {});
    await store.updateBusiness(b.id, { vapi_phone_number_id: id, phone_number: number });
  } catch (e) { throw httpError(502, e.message); }
  res.json(profile(await businessOr404(b.id), req));
}));

me.get('/orders', wrap(async (req, res) => res.json(await store.listOrders(req.businessId))));
me.patch('/orders/:id', wrap(async (req, res) => {
  try { await store.setFulfilment(req.businessId, +req.params.id, req.body?.fulfilment); }
  catch (e) { throw httpError(400, e.message); }
  res.json({ ok: true });
}));
me.get('/transcripts', wrap(async (req, res) => res.json(await store.listTranscripts(req.businessId))));
me.get('/menu', wrap(async (req, res) => res.json(await store.getMenu(req.businessId))));
me.post('/menu', wrap(async (req, res) => {
  const { name, aliases, priceNaira } = req.body || {};
  try {
    await store.addMenuItem(req.businessId, {
      name, priceKobo: kobo(priceNaira), aliases: String(aliases || '').split(',').map(s => s.trim()).filter(Boolean),
    });
  } catch (e) { throw httpError(400, e.code === '23505' ? 'That item already exists' : e.message); }
  res.json({ ok: true });
}));
me.patch('/menu/:id', wrap(async (req, res) => {
  const { name, aliases, priceNaira, available } = req.body || {};
  try {
    await store.updateMenuItem(req.businessId, +req.params.id, {
      name, available, priceKobo: priceNaira !== undefined ? kobo(priceNaira) : undefined,
      aliases: aliases === undefined ? undefined : String(aliases).split(',').map(s => s.trim()).filter(Boolean),
    });
  } catch (e) { throw httpError(400, e.code === '23505' ? 'Another item already has that name' : e.message); }
  res.json({ ok: true });
}));
me.delete('/menu/:id', wrap(async (req, res) => { await store.deleteMenuItem(req.businessId, +req.params.id); res.json({ ok: true }); }));
app.use('/api/me', me);

// ---------- Public ordering page ----------
app.get('/api/public/:businessId', wrap(async (req, res) => {
  const b = await businessOr404(req.params.businessId);
  res.json({
    name: b.name, phoneNumber: b.phone_number,
    vapiPublicKey: process.env.VAPI_PUBLIC_KEY || null, vapiAssistantId: b.vapi_assistant_id,
    menu: (await store.getMenu(b.id)).filter(m => m.available),
  });
}));

app.post('/api/chat', wrap(async (req, res) => {
  const { businessId, sessionId, phone, messages } = req.body || {};
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(sessionId || '') || !Array.isArray(messages) || messages.length > 60) throw httpError(400, 'Bad request');
  const business = await businessOr404(businessId);
  const callId = `web_${business.id}_${sessionId}`; // scoped per business: a reused session id can't read another shop's order
  const ctx = { businessId: business.id, business, callId, phone, channel: 'web' };
  const { reply, steps } = await runAgent(messages, ctx, agentDeps);
  const all = [...messages, { role: 'assistant', content: reply }];
  await store.saveTranscript({
    businessId: business.id, callId, phone, messages: all,
    transcript: all.filter(m => m.role !== 'system').map(m => `${m.role === 'user' ? 'Customer' : 'Orderly'}: ${m.content}`).join('\n'),
  });
  res.json({ reply, steps, order: await store.getOrder(callId) });
}));

app.get('/api/order/:callId', wrap(async (req, res) => res.json(await store.getOrderView(req.params.callId))));

// ---------- Voice: Vapi custom LLM (OpenAI-compatible) ----------
// Secret + business id are path segments because Vapi appends /chat/completions to the configured URL.
app.post('/llm/:key/:businessId/chat/completions', wrap(async (req, res) => {
  if (req.params.key !== process.env.VAPI_SECRET) return res.sendStatus(401);
  const business = await businessOr404(req.params.businessId);
  const { messages = [], call = {} } = req.body;
  const ctx = { businessId: business.id, business, callId: call.id || `unknown_${Date.now()}`, phone: call.customer?.number, channel: 'phone' };

  let reply;
  try { ({ reply } = await runAgent(messages, ctx, agentDeps)); }
  catch (e) { console.error('agent error', e); reply = 'Sorry, I had a small problem. Could you say that again?'; }

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (req.body.stream === false) {
    return res.json({ id, object: 'chat.completion', created, model: 'orderly', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
  }
  const chunk = c => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'orderly', choices: [{ index: 0, ...c }] })}\n\n`;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.send(chunk({ delta: { role: 'assistant', content: reply } }) + chunk({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
}));

// End-of-call report -> transcripts for QA.
app.post('/vapi/:businessId', wrap(async (req, res) => {
  if (req.get('x-vapi-secret') !== process.env.VAPI_SECRET) return res.sendStatus(401);
  const b = await businessOr404(req.params.businessId);
  const msg = req.body?.message || {};
  if (msg.type === 'end-of-call-report' && msg.call?.id) {
    await store.saveTranscript({
      businessId: b.id, callId: msg.call.id, phone: msg.call.customer?.number,
      transcript: msg.artifact?.transcript ?? msg.transcript, messages: msg.artifact?.messages ?? msg.messages,
      recordingUrl: msg.artifact?.recordingUrl ?? msg.recordingUrl, endedReason: msg.endedReason,
    });
  }
  res.json({});
}));

// ---------- Payments: each business sets this URL as the webhook in its own Paystack dashboard ----------
// Work is done before responding because Lambda freezes once the response is sent.
// One platform webhook for every business: set once in the platform Paystack dashboard.
app.post(['/paystack/webhook', '/paystack/webhook/:businessId'], wrap(async (req, res) => {
  if (!paystack.validSignature(req.rawBody, req.get('x-paystack-signature'))) return res.sendStatus(401);
  const { event, data } = req.body;
  if (event === 'charge.success') {
    const tx = await paystack.verify(data.reference);
    if (tx.status === 'success') {
      let r;
      try {
        r = await store.mutate({ paymentRef: tx.reference }, { type: 'payment_success', reference: tx.reference, amountKobo: tx.amount });
      } catch (e) { if (e.message === 'Unknown payment reference') return res.sendStatus(200); throw e; }
      const b = await store.getBusiness((await store.pool.query('SELECT business_id FROM orders WHERE id=$1', [r.orderId])).rows[0].business_id);
      if (r.ok && r.phone) await sms.send(r.phone, `${b.name}: payment received. Order #${r.orderId} is being prepared. Thank you!`).catch(console.error);
      if (r.ok) await email.sendPaymentReceived(b, r.orderId, r.order, r.phone);
      if (!r.ok) console.warn('payment rejected by state machine', tx.reference, r.error);
    }
  }
  res.sendStatus(200);
}));

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`Orderly on http://localhost:${port}`));
module.exports = app;
