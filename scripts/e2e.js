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
  ok(r.status === 200 && r.body.verifyRequired && !r.body.token, 'signup asks for email verification (no session yet)');
  r = await req('/api/auth/login', { body: { email: A.email, password: A.password } });
  ok(r.status === 403 && r.body.verifyRequired, 'login blocked until email verified');
  ok((await req('/api/auth/resend-verification', { body: { email: A.email } })).status === 200, 'resend verification');
  ok((await req('/api/auth/verify', { body: { token: 'not-a-real-token' } })).status === 400, 'bad verification link rejected');
  ok(!!(await verifyEmail(A.email)), 'verification link logs the business in');
  r = await req('/api/auth/signup', { body: A });
  ok(r.status === 409, 'duplicate signup rejected');
  r = await req('/api/auth/signup', { body: { ...A, email: 'bad', password: '1' } });
  ok(r.status === 400, 'invalid signup rejected');
  r = await req('/api/auth/login', { body: { email: A.email, password: 'wrong-pass' } });
  ok(r.status === 401, 'wrong password rejected');
  r = await req('/api/auth/login', { body: { email: A.email.toUpperCase(), password: A.password } });
  ok(r.status === 200, 'login (email case-insensitive)');
  const tA = r.body.token;
  await req('/api/auth/signup', { body: B });
  const tB = await verifyEmail(B.email);
  ok((await req('/api/me', { token: 'garbage' })).status === 401, 'bad token rejected');
  // --- Passwords
  ok((await req('/api/me/password', { token: tA, body: { currentPassword: 'wrong-one', newPassword: 'newpass123' } })).status === 400, 'change password rejects wrong current password');
  ok((await req('/api/me/password', { token: tA, body: { currentPassword: A.password, newPassword: 'short' } })).status === 400, 'change password rejects short password');
  ok((await req('/api/me/password', { token: tA, body: { currentPassword: A.password, newPassword: 'newpass123' } })).status === 200, 'change password');
  ok((await req('/api/auth/login', { body: { email: A.email, password: 'newpass123' } })).status === 200, 'log in with the new password');
  ok((await req('/api/auth/forgot', { body: { email: A.email } })).status === 200, 'forgot password request');
  ok((await req('/api/auth/forgot', { body: { email: 'nobody-' + stamp + '@example.com' } })).status === 200, 'forgot password does not reveal unknown emails');
  ok((await req('/api/auth/reset', { body: { token: 'not-real', password: 'whatever123' } })).status === 400, 'bad reset link rejected');
  r = await req('/api/auth/reset', { body: { token: await plantToken('reset', A.email), password: A.password } });
  ok(r.status === 200 && !!r.body.token, 'reset password with emailed link logs in');
  ok((await req('/api/auth/login', { body: { email: A.email, password: A.password } })).status === 200, 'log in after reset');
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
  const banks = (await req('/api/banks')).body;
  ok(Array.isArray(banks) && banks.length > 20, 'bank list loads', `${banks.length} banks`);
  ok((await req('/api/me/payout', { token: tA, body: { bankCode: '057', accountNumber: '123' } })).status === 400, 'short account number rejected');
  ok((await req('/api/me/payout', { token: tA, body: { bankCode: '999999', accountNumber: '0001234567' } })).status === 400, 'unknown bank rejected');
  r = await req('/api/me/payout', { token: tA, body: { bankCode: '057', accountNumber: '0000000000' } });
  if (String(env.PAYSTACK_SECRET_KEY).startsWith('sk_live_')) ok(r.status === 400, 'live mode rejects a fake bank account', r.body.error);
  else ok(r.status === 200 && r.body.payout?.accountName, 'bank account saved', JSON.stringify(r.body.payout || r.body));

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
  await req(`/api/me/menu/${id('Jollof Rice')}`, { method: 'PATCH', token: tA, body: { name: 'Party Jollof', aliases: 'jollof, jollof rice' } });
  menu = (await req('/api/me/menu', { token: tA })).body;
  ok(menu.some(m => m.name === 'Party Jollof' && m.aliases.includes('jollof rice')), 'rename item + edit other names');
  ok((await req(`/api/me/menu/${menu.find(m => m.name === 'Party Jollof').id}`, { method: 'PATCH', token: tA, body: { name: 'Chicken' } })).status === 400, 'rename to duplicate name rejected');
  await req(`/api/me/menu/${menu.find(m => m.name === 'Party Jollof').id}`, { method: 'PATCH', token: tA, body: { name: 'Jollof Rice' } });

  // --- Google sign-in config
  ok(!!(await req('/api/auth/config')).body.googleClientId, 'Google sign-in configured');
  ok((await req('/api/auth/google', { body: { credential: 'fake' } })).status === 401, 'fake Google credential rejected');

  // --- One sign-in method per email
  await (await getDb()).query("UPDATE businesses SET auth_provider='google' WHERE email=lower($1)", [B.email]);
  r = await req('/api/auth/login', { body: { email: B.email, password: B.password } });
  ok(r.status === 400 && /Google/.test(r.body.error), 'Google account cannot log in with a password');
  r = await req('/api/auth/signup', { body: { ...B, name: 'Dup' } });
  ok(r.status === 409 && /Google/.test(r.body.error), 'cannot register a password account with a Google email');
  ok((await req('/api/me/password', { token: tB, body: { currentPassword: B.password, newPassword: 'newpass123' } })).status === 400, 'Google account has no password to change');
  ok((await req('/api/me', { token: tA })).body.authProvider === 'password', 'password account reports its sign-in method');

  // --- Bookings, money, receipts
  r = await req('/api/me/bookings', { token: tA, body: { customerName: 'Ada', customerPhone: '+2348000000000', service: 'Haircut', startsAt: new Date(Date.now() - 3600e3).toISOString(), priceNaira: 3000 } });
  ok(r.status === 200 && r.body.id, 'add booking');
  ok((await req('/api/me/bookings', { token: tA, body: { customerName: '', service: 'x', startsAt: 'bad' } })).status === 400, 'invalid booking rejected');
  ok((await req('/api/me/bookings/' + r.body.id, { method: 'PATCH', token: tA, body: { status: 'completed' } })).body.status === 'completed', 'complete booking');
  ok((await req('/api/me/bookings', { token: tB })).body.length === 0, "other business can't see my bookings");
  ok((await req('/api/me/transactions', { token: tA, body: { kind: 'expense', amountNaira: 1200, category: 'Stock' } })).status === 200, 'record expense');
  ok((await req('/api/me/transactions', { token: tA, body: { kind: 'expense', amountNaira: -5 } })).status === 400, 'negative amount rejected');
  const acc = (await req('/api/me/accounting?days=7', { token: tA })).body;
  ok(acc.incomeKobo === 300000 && acc.expensesKobo === 120000 && acc.netKobo === 180000 && acc.daily.length === 7, 'accounting: in ₦3,000, out ₦1,200, profit ₦1,800', `net ₦${acc.netKobo / 100}`);
  ok((await req('/api/receipts/1.forgedsignatureforged12')).status === 404, 'forged receipt link rejected');

  // --- Showcase media
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  ok((await req('/api/me/media/upload-url', { token: tA, body: { contentType: 'application/pdf', size: 10 } })).status === 400, 'non-media file type rejected');
  const up = (await req('/api/me/media/upload-url', { token: tA, body: { contentType: 'image/png', size: png.length } })).body;
  const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
  ok(put.ok, 'photo uploads to storage', String(put.status));
  const m = (await req('/api/me/media', { token: tA, body: { key: up.key, kind: up.kind, caption: 'Our best jollof' } })).body;
  ok((await fetch(m.url)).ok, 'uploaded photo is publicly viewable');
  ok((await req('/api/public/' + meA.id)).body.media?.some(x => x.id === m.id), 'visible photo shows on customer page');
  await req('/api/me/media/' + m.id, { method: 'PATCH', token: tA, body: { visible: false } });
  ok(!(await req('/api/public/' + meA.id)).body.media?.some(x => x.id === m.id), 'hidden photo disappears from customer page');
  ok((await req('/api/me/media', { token: tA, body: { key: 'media/someone-else/x.png', kind: 'image' } })).status === 400, "can't register another business's file");
  await req('/api/me/media/' + m.id, { method: 'DELETE', token: tA });
  ok((await req('/api/me/media', { token: tA })).body.length === 0, 'delete photo');

  // --- MCP server
  const mk = (await req('/api/me/mcp-key', { token: tA, body: {} })).body;
  ok(/^ord_/.test(mk.key || '') && mk.url.endsWith('/mcp'), 'create MCP key');
  const rpc = async (method, params, key = mk.key) => (await req('/mcp', { body: { jsonrpc: '2.0', id: 1, method, params }, headers: { Authorization: `Bearer ${key}` } }));
  ok((await rpc('tools/list', {}, 'ord_wrong')).status === 401, 'MCP rejects a wrong key');
  r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  ok(r.body.result?.serverInfo?.name === 'orderly', 'MCP initialize');
  r = await rpc('tools/list', {});
  ok(r.body.result?.tools?.length === 7, 'MCP lists 7 tools');
  r = await rpc('tools/call', { name: 'list_menu', arguments: {} });
  ok(/Jollof Rice/.test(r.body.result?.content?.[0]?.text || ''), 'MCP list_menu', (r.body.result?.content?.[0]?.text || '').split(String.fromCharCode(10))[0]);
  const sid0 = (await req('/api/me/menu', { token: tA })).body.find(m => m.name === 'Chicken').id;
  r = await rpc('tools/call', { name: 'update_menu_item', arguments: { item_id: sid0, available: false } });
  ok(/SOLD OUT/.test(r.body.result?.content?.[0]?.text || ''), 'MCP marks item sold out');
  await rpc('tools/call', { name: 'update_menu_item', arguments: { item_id: sid0, available: true } });
  r = await rpc('tools/call', { name: 'get_sales_summary', arguments: {} });
  ok(/paid order/.test(r.body.result?.content?.[0]?.text || ''), 'MCP sales summary', r.body.result?.content?.[0]?.text);
  r = await rpc('tools/call', { name: 'update_order_status', arguments: { order_id: 999999, status: 'ready' } });
  ok(r.body.result?.isError === true, 'MCP refuses unknown order');
  r = await (await fetch(API + '/mcp?key=' + mk.key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) })).json();
  ok(r.result && !r.error, 'MCP key in URL works (for connectors)');

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

  // --- Shared phone line: caller picks the business by code, then orders
  const code = (await req('/api/me', { token: tA })).body.shortCode;
  ok(/^\d{4}$/.test(code || ''), 'business has a 4-digit code', code);
  const sharedCall = `e2e-shared-${stamp}`, hist = [];
  const shared = async content => {
    hist.push({ role: 'user', content });
    const res = await req(`/llm/${env.VAPI_SECRET}/shared/chat/completions`, { body: { stream: true, call: { id: sharedCall }, messages: hist } });
    const text = String(res.body).split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)).choices[0].delta.content || '').join('');
    hist.push({ role: 'assistant', content: text });
    console.log(`   ☎️  ${content}\n   🔊 ${text}`);
    return text;
  };
  const t1 = await shared(`I want to order from business code ${code.split('').join(' ')}`);
  ok(t1.includes('E2E Kitchen'), 'shared line connects caller to the right business by code');
  await shared('One jollof rice please');
  view = (await req(`/api/order/${sharedCall}`)).body;
  ok(view.items?.[0]?.name === 'Jollof Rice', 'order on shared line saved to that business');

  // --- End-of-call report → transcripts
  r = await req(`/vapi/${meA.id}`, { headers: { 'x-vapi-secret': env.VAPI_SECRET }, body: { message: { type: 'end-of-call-report', call: { id: callId, customer: { number: '+2348000000000' } }, endedReason: 'customer-ended-call', artifact: { transcript: 'AI: Hello\nUser: One jollof', messages: [] } } } });
  ok(r.status === 200, 'end-of-call report accepted');
  ok((await req(`/vapi/${meA.id}`, { body: { message: {} } })).status === 401, 'end-of-call report needs secret');
  const tx = (await req('/api/me/transcripts', { token: tA })).body;
  ok(tx.some(t => t.call_id === callId) && tx.some(t => t.call_id === webCall), 'transcripts listed (phone + web)');
  ok(!(await req('/api/me/transcripts', { token: tB })).body.some(t => t.call_id === callId || t.call_id === webCall), "other business can't see my transcripts");

  // --- Orders dashboard
  const orders = (await req('/api/me/orders', { token: tA })).body;
  ok(orders.length === 3, 'dashboard lists all 3 orders (web, phone, shared line)');
  r = await req(`/api/me/orders/${orders[0].id}`, { method: 'PATCH', token: tA, body: { fulfilment: 'preparing' } });
  ok(r.status === 200, 'update kitchen status');
  ok((await req(`/api/me/orders/${orders[0].id}`, { method: 'PATCH', token: tA, body: { fulfilment: 'hacked' } })).status === 400, 'bad kitchen status rejected');
  ok((await req('/api/me/orders', { token: tB })).body.length === 0, "other business can't see my orders");

  // --- Phone number (free Vapi number)
  r = await req('/api/me/phone-number', { token: tA, body: {} });
  if (/maximum number of free phone numbers/.test(r.body.error || '')) console.log('⏭️  get a phone number — skipped: Vapi free-number limit used by a real business');
  else {
    ok(r.status === 200 && r.body.phoneNumber, 'get a phone number', r.body.phoneNumber || JSON.stringify(r.body));
    ok((await req('/api/me/phone-number', { token: tA, body: {} })).status === 409, 'second number blocked');
  }

  console.log(`\nPayment link for a manual test payment (Paystack test card): ${(await req(`/api/order/${webCall}`)).body.paymentUrl}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.argv.includes('--keep')) return console.log('Kept test data (--keep).');
  await cleanup();
})().catch(async e => { console.error('CRASH', e); await cleanup(); process.exit(1); });

// Resolve via public DNS (some local resolvers drop AWS hostnames); SNI keeps Neon routing intact.
let dbPool;
async function getDb() {
  if (dbPool) return dbPool;
  const u = new URL(env.PROD_DATABASE_URL);
  const resolver = new (require('dns').promises.Resolver)(); resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const [ip] = await resolver.resolve4(u.hostname);
  return (dbPool = new Pool({ host: ip, port: +u.port || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), ssl: { servername: u.hostname } }));
}

// Simulates clicking the emailed link: plant a known token, then call the real verify endpoint.
async function plantToken(kind, email) {
  const token = crypto.randomBytes(16).toString('hex');
  await (await getDb()).query(`UPDATE businesses SET ${kind}_token_hash = $1, ${kind}_sent_at = now() WHERE email = lower($2)`,
    [crypto.createHash('sha256').update(token).digest('hex'), email]);
  return token;
}
async function verifyEmail(email) {
  const token = await plantToken('verify', email);
  return (await req('/api/auth/verify', { body: { token } })).body.token;
}

async function cleanup() {
  const db = await getDb();
  const { rows } = await db.query("DELETE FROM businesses WHERE email LIKE 'e2e-%@example.com' RETURNING vapi_assistant_id, vapi_phone_number_id");
  await db.end();
  const del = p => fetch(`https://api.vapi.ai${p}`, { method: 'DELETE', headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` } });
  for (const b of rows) {
    if (b.vapi_phone_number_id) await del(`/phone-number/${b.vapi_phone_number_id}`);
    if (b.vapi_assistant_id) await del(`/assistant/${b.vapi_assistant_id}`);
  }
  console.log(`🧹 cleaned up ${rows.length} test businesses (+ their Vapi assistants/numbers)`);
}
