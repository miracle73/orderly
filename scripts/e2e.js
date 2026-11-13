// Live end-to-end test against the deployed backend + frontend. Creates two test businesses and cleans up after.
// Usage: node scripts/e2e.js            (reads keys from .env)
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const API = (process.env.E2E_API || require('fs').readFileSync(__dirname + '/../public/config.js', 'utf8').match(/'(https:[^']+)'/)[1]).replace(/\/$/, '');
const WEB = process.env.FRONTEND_URL || 'https://orderly-ebon.vercel.app';
const env = process.env;
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`); };
const req = async (path, { method, body, token, headers = {} } = {}) => {
  const r = await fetch(API + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Origin: WEB, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : body && JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
};
const stamp = Date.now();
const created = { emails: [], phoneIds: [] };

(async () => {
  if (process.argv.includes('--cleanup-only')) return cleanup();
  console.log(`API ${API}\nWEB ${WEB}\n`);

  // --- Frontend
  for (const p of ['', 'login.html', 'dashboard.html', 'call.html', 'paid.html', 'config.js']) {
    const r = await fetch(`${WEB}/${p}`);
    ok(r.status === 200, `frontend /${p} loads`);
  }
  ok((await (await fetch(`${WEB}/config.js`)).text()).includes(API), 'frontend points at live backend');

  // --- Auth
  const A = { email: `e2e-a-${stamp}@example.com`, password: 'password123', name: 'E2E Kitchen' };
  const B = { email: `e2e-b-${stamp}@example.com`, password: 'password123', name: 'E2E Other' };
  created.emails.push(A.email, B.email);
  let r = await req('/api/auth/signup', { body: A });
  ok(r.status === 200 && r.body.token, 'signup');
  r = await req('/api/auth/signup', { body: A });
  ok(r.status === 409, 'duplicate signup rejected');
  r = await req('/api/auth/signup', { body: { ...A, email: 'bad', password: '1' } });
  ok(r.status === 400, 'invalid signup rejected');
  r = await req('/api/auth/login', { body: { email: A.email, password: 'wrong-pass' } });
  ok(r.status === 401, 'wrong password rejected');
  r = await req('/api/auth/login', { body: { email: A.email.toUpperCase(), password: A.password } });
  ok(r.status === 200, 'login (email case-insensitive)');
  const tA = r.body.token;
  const tB = (await req('/api/auth/signup', { body: B })).body.token;
  ok((await req('/api/me', { token: 'garbage' })).status === 401, 'bad token rejected');
  r = await req('/api/me', { token: tA });
  const meA = r.body;
  ok(r.status === 200 && meA.name === A.name, 'profile loads');
  ok(meA.voiceReady, 'voice assistant created at signup');

  // --- CORS
  r = await req('/api/me', { method: 'OPTIONS' });
  ok(r.status === 204 && r.headers.get('access-control-allow-origin') === WEB, 'CORS allows the Vercel site');

  // --- Business settings
  r = await req('/api/me', { method: 'PATCH', token: tA, body: { name: 'E2E Kitchen Renamed' } });
  ok(r.body.name === 'E2E Kitchen Renamed', 'rename business');
  r = await req('/api/me', { method: 'PATCH', token: tA, body: { paystackSecretKey: 'sk_test_definitelynotreal123' } });
  ok(r.status === 400, 'invalid Paystack key rejected');
  r = await req('/api/me', { method: 'PATCH', token: tA, body: { paystackSecretKey: env.PAYSTACK_SECRET_KEY } });
  ok(r.body.paystackConnected === true, 'connect real Paystack test key');

  // --- Menu
  for (const [name, priceNaira, aliases] of [['Jollof Rice', 2500, 'jollof'], ['Chicken', 1500, ''], ['Coke', 500, 'coca cola'], ['Suya', 2000, '']]) {
    r = await req('/api/me/menu', { token: tA, body: { name, priceNaira, aliases } });
  }
  ok(r.status === 200, 'add menu items');
  ok((await req('/api/me/menu', { token: tA, body: { name: 'Coke', priceNaira: 500 } })).status === 400, 'duplicate menu item rejected');
  ok((await req('/api/me/menu', { token: tA, body: { name: 'Free', priceNaira: 0 } })).status === 400, 'zero price rejected');
  let menu = (await req('/api/me/menu', { token: tA })).body;
  const id = n => menu.find(m => m.name === n).id;
  await req(`/api/me/menu/${id('Chicken')}`, { method: 'PATCH', token: tA, body: { priceNaira: 1800 } });
  await req(`/api/me/menu/${id('Suya')}`, { method: 'PATCH', token: tA, body: { available: false } });
  await req(`/api/me/menu/${id('Coke')}`, { method: 'DELETE', token: tA });
  menu = (await req('/api/me/menu', { token: tA })).body;
  ok(menu.find(m => m.name === 'Chicken')?.priceKobo === 180000, 'edit price');
  ok(menu.find(m => m.name === 'Suya')?.available === false, 'mark item unavailable');
  ok(!menu.find(m => m.name === 'Coke'), 'delete item');

  // --- Isolation
  await req(`/api/me/menu/${id('Chicken')}`, { method: 'PATCH', token: tB, body: { priceNaira: 1 } });
  await req(`/api/me/menu/${id('Chicken')}`, { method: 'DELETE', token: tB });
  menu = (await req('/api/me/menu', { token: tA })).body;
  ok(menu.find(m => m.name === 'Chicken')?.priceKobo === 180000, "other business can't edit or delete my menu");
  ok((await req('/api/me/menu', { token: tB })).body.length === 0, "other business can't see my menu");

  // --- Public page data
  r = await req(`/api/public/${meA.id}`);
  ok(r.status === 200 && r.body.menu.length === 2 && r.body.vapiAssistantId, 'public ordering page data (only available items)');
  ok((await req('/api/public/00000000-0000-0000-0000-000000000000')).status === 404, 'unknown business 404');

  // --- Web ordering through the AI agent
  const sid = `e2e${stamp}`;
  const msgs = [];
  const say = async text => {
    msgs.push({ role: 'user', content: text });
    const res = await req('/api/chat', { body: { businessId: meA.id, sessionId: sid, messages: msgs } });
    msgs.push({ role: 'assistant', content: res.body.reply });
    console.log(`   🧑 ${text}\n   🤖 ${res.body.reply}`);
    return res.body;
  };
  let c = await say('Hi, I want two jollof rice and one chicken');
  ok(c.order.items.length === 2 && !!c.reply, 'agent adds items and replies');
  c = await say('Actually make the chicken three');
  const chicken = c.order.items.find(i => i.name === 'Chicken');
  ok(chicken?.qty === 3, '"make that three" updates quantity', JSON.stringify(c.order.items.map(i => `${i.qty}x${i.name}`)));
  c = await say('Can I also get suya?');
  ok(!c.order.items.find(i => i.name === 'Suya'), 'unavailable item refused');
  c = await say("That's all");
  c = await say('Yes, confirm it');
  const webCall = `web_${meA.id}_${sid}`;
  let view = (await req(`/api/order/${webCall}`)).body;
  ok(view.status === 'awaiting_payment' && /checkout\.paystack\.com/.test(view.paymentUrl || ''), 'confirm → Paystack payment link created', view.paymentUrl);
  ok(view.totalKobo === 2 * 250000 + 3 * 180000, 'total correct (₦10,400)', `₦${view.totalKobo / 100}`);
  ok(c.reply.includes('checkout.paystack.com'), 'agent gives the link to the customer');

  // --- Same session id on another business can't touch this order
  const meB = (await req('/api/me', { token: tB })).body;
  r = await req('/api/chat', { body: { businessId: meB.id, sessionId: sid, messages: [{ role: 'user', content: 'what is my order?' }] } });
  ok(r.status === 200 && r.body.order.items.length === 0, "session id reused on another business sees nothing");

  // --- Paystack webhook
  const payload = JSON.stringify({ event: 'charge.success', data: { reference: view.paymentRef } });
  r = await req(`/paystack/webhook/${meA.id}`, { body: payload });
  ok(r.status === 401, 'unsigned webhook rejected');
  const sig = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(payload).digest('hex');
  r = await req(`/paystack/webhook/${meA.id}`, { body: payload, headers: { 'x-paystack-signature': sig } });
  view = (await req(`/api/order/${webCall}`)).body;
  ok(r.status === 200 && view.status === 'awaiting_payment', 'signed webhook for an UNPAID transaction does not mark it paid');

  // --- Voice: Vapi custom-LLM endpoint
  const callId = `e2e-call-${stamp}`;
  const voice = async content => {
    const res = await req(`/llm/${env.VAPI_SECRET}/${meA.id}/chat/completions`, {
      body: { stream: true, call: { id: callId, customer: { number: '+2348000000000' } }, messages: [{ role: 'system', content: 'x' }, { role: 'user', content }] },
    });
    const text = String(res.body).split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)).choices[0].delta.content || '').join('');
    console.log(`   📞 ${content}\n   🔊 ${text}`);
    return { status: res.status, text, type: res.headers.get('content-type') };
  };
  const v = await voice('Hello, one jollof rice please');
  ok(v.status === 200 && v.type.includes('text/event-stream') && v.text.length > 0, 'voice endpoint streams a reply (SSE)');
  view = (await req(`/api/order/${callId}`)).body;
  ok(view.items?.[0]?.name === 'Jollof Rice', 'voice order saved for the call');
  ok((await req(`/llm/wrong-secret/${meA.id}/chat/completions`, { body: { messages: [] } })).status === 401, 'voice endpoint rejects wrong secret');

  // --- End-of-call report → transcripts
  r = await req(`/vapi/${meA.id}`, { headers: { 'x-vapi-secret': env.VAPI_SECRET }, body: { message: { type: 'end-of-call-report', call: { id: callId, customer: { number: '+2348000000000' } }, endedReason: 'customer-ended-call', artifact: { transcript: 'AI: Hello\nUser: One jollof', messages: [] } } } });
  ok(r.status === 200, 'end-of-call report accepted');
  ok((await req(`/vapi/${meA.id}`, { body: { message: {} } })).status === 401, 'end-of-call report needs secret');
  const tx = (await req('/api/me/transcripts', { token: tA })).body;
  ok(tx.some(t => t.call_id === callId) && tx.some(t => t.call_id === webCall), 'transcripts listed (phone + web)');
  ok(!(await req('/api/me/transcripts', { token: tB })).body.some(t => t.call_id === callId || t.call_id === webCall), "other business can't see my transcripts");

  // --- Orders dashboard
  const orders = (await req('/api/me/orders', { token: tA })).body;
  ok(orders.length === 2, 'dashboard lists both orders');
  r = await req(`/api/me/orders/${orders[0].id}`, { method: 'PATCH', token: tA, body: { fulfilment: 'preparing' } });
  ok(r.status === 200, 'update kitchen status');
  ok((await req(`/api/me/orders/${orders[0].id}`, { method: 'PATCH', token: tA, body: { fulfilment: 'hacked' } })).status === 400, 'bad kitchen status rejected');
  ok((await req('/api/me/orders', { token: tB })).body.length === 0, "other business can't see my orders");

  // --- Phone number (free Vapi number)
  r = await req('/api/me/phone-number', { token: tA, body: {} });
  ok(r.status === 200 && r.body.phoneNumber, 'get a phone number', r.body.phoneNumber || JSON.stringify(r.body));
  ok((await req('/api/me/phone-number', { token: tA, body: {} })).status === 409, 'second number blocked');

  console.log(`\nPayment link for a manual test payment (Paystack test card): ${(await req(`/api/order/${webCall}`)).body.paymentUrl}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.argv.includes('--keep')) return console.log('Kept test data (--keep).');
  await cleanup();
})().catch(async e => { console.error('CRASH', e); await cleanup(); process.exit(1); });

async function cleanup() {
  // Resolve via public DNS (some local resolvers drop AWS hostnames); SNI keeps Neon routing intact.
  const u = new URL(env.PROD_DATABASE_URL);
  const resolver = new (require('dns').promises.Resolver)(); resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const [ip] = await resolver.resolve4(u.hostname);
  const db = new Pool({ host: ip, port: +u.port || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), ssl: { servername: u.hostname } });
  const { rows } = await db.query("DELETE FROM businesses WHERE email LIKE 'e2e-%@example.com' RETURNING vapi_assistant_id, vapi_phone_number_id");
  await db.end();
  const del = p => fetch(`https://api.vapi.ai${p}`, { method: 'DELETE', headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` } });
  for (const b of rows) {
    if (b.vapi_phone_number_id) await del(`/phone-number/${b.vapi_phone_number_id}`);
    if (b.vapi_assistant_id) await del(`/assistant/${b.vapi_assistant_id}`);
  }
  console.log(`🧹 cleaned up ${rows.length} test businesses (+ their Vapi assistants/numbers)`);
}
