const { Pool } = require('pg');
const { newOrder, apply } = require('./orderMachine');

// On Lambda keep one connection per container; use Neon's pooled connection string.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: process.env.AWS_LAMBDA_FUNCTION_NAME ? 1 : 10 });

// ---------- Businesses ----------
async function createBusiness({ name, email, passwordHash }) {
  const { rows } = await pool.query(
    'INSERT INTO businesses (name, email, password_hash) VALUES ($1, lower($2), $3) RETURNING *', [name, email, passwordHash]);
  return rows[0];
}
async function getBusinessByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE email = lower($1)', [email]);
  return rows[0] || null;
}
async function getBusiness(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [id]);
  return rows[0] || null;
}
const BUSINESS_FIELDS = ['name', 'paystack_secret_enc', 'vapi_assistant_id', 'vapi_phone_number_id', 'phone_number'];
async function updateBusiness(id, fields) {
  const keys = Object.keys(fields).filter(k => BUSINESS_FIELDS.includes(k));
  if (!keys.length) return;
  await pool.query(`UPDATE businesses SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...keys.map(k => fields[k])]);
}

// ---------- Menu ----------
async function getMenu(businessId, client = pool) {
  const { rows } = await client.query(
    'SELECT id, name, aliases, price_kobo, available FROM menu_items WHERE business_id = $1 ORDER BY id', [businessId]);
  return rows.map(r => ({ id: r.id, name: r.name, aliases: r.aliases, priceKobo: r.price_kobo, available: r.available }));
}
async function addMenuItem(businessId, { name, aliases = [], priceKobo }) {
  if (!name || !Number.isInteger(priceKobo) || priceKobo <= 0) throw new Error('Name and a positive price are required');
  await pool.query('INSERT INTO menu_items (business_id, name, aliases, price_kobo) VALUES ($1,$2,$3,$4)',
    [businessId, name.trim(), aliases, priceKobo]);
}
async function updateMenuItem(businessId, id, { priceKobo, available }) {
  if (priceKobo !== undefined && (!Number.isInteger(priceKobo) || priceKobo <= 0)) throw new Error('Bad price');
  await pool.query(
    `UPDATE menu_items SET price_kobo = COALESCE($1, price_kobo), available = COALESCE($2, available)
     WHERE id = $3 AND business_id = $4`, [priceKobo ?? null, available ?? null, id, businessId]);
}
async function deleteMenuItem(businessId, id) {
  await pool.query('DELETE FROM menu_items WHERE id = $1 AND business_id = $2', [id, businessId]);
}

// ---------- Orders ----------
async function getOrder(callId) {
  const { rows } = await pool.query('SELECT state FROM orders WHERE call_id = $1', [callId]);
  return rows[0]?.state || newOrder();
}

async function getOrderView(callId) {
  const { rows } = await pool.query('SELECT state, payment_url FROM orders WHERE call_id = $1', [callId]);
  if (!rows[0]) return newOrder();
  const s = rows[0].state;
  return { ...s, paymentUrl: s.status === 'awaiting_payment' ? rows[0].payment_url : null };
}

async function setPaymentUrl(callId, url) {
  await pool.query('UPDATE orders SET payment_url = $1 WHERE call_id = $2', [url, callId]);
}

// Applies one action atomically. Row lock serialises concurrent tool calls / webhooks.
async function mutate({ businessId, callId, paymentRef, phone }, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let row;
    if (paymentRef) {
      ({ rows: [row] } = await client.query(
        'SELECT * FROM orders WHERE payment_ref = $1 AND business_id = $2 FOR UPDATE', [paymentRef, businessId]));
      if (!row) throw new Error('Unknown payment reference');
    } else {
      await client.query(
        `INSERT INTO orders (business_id, call_id, customer_phone, state, status) VALUES ($1, $2, $3, $4, 'building')
         ON CONFLICT (call_id) DO NOTHING`, [businessId, callId, phone || null, newOrder()]);
      ({ rows: [row] } = await client.query('SELECT * FROM orders WHERE call_id = $1 FOR UPDATE', [callId]));
      if (row.business_id !== businessId) throw new Error('Call belongs to another business');
    }
    const result = apply(row.state, action, await getMenu(businessId, client));
    await client.query('INSERT INTO order_events (order_id, action, ok, error) VALUES ($1, $2, $3, $4)',
      [row.id, action, result.ok, result.error || null]);
    if (result.ok) {
      await client.query(
        'UPDATE orders SET state = $1, status = $2, payment_ref = $3, updated_at = now() WHERE id = $4',
        [result.order, result.order.status, result.order.paymentRef, row.id]);
    }
    await client.query('COMMIT');
    return { ...result, order: result.order || row.state, orderId: row.id, phone: row.customer_phone };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listOrders(businessId) {
  const { rows } = await pool.query(
    `SELECT id, call_id, customer_phone, state, status, fulfilment, created_at, updated_at
     FROM orders WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 200`, [businessId]);
  return rows;
}

const FULFILMENT = ['new', 'preparing', 'ready', 'delivered'];
async function setFulfilment(businessId, id, fulfilment) {
  if (!FULFILMENT.includes(fulfilment)) throw new Error('Bad status');
  await pool.query('UPDATE orders SET fulfilment = $1, updated_at = now() WHERE id = $2 AND business_id = $3',
    [fulfilment, id, businessId]);
}

// ---------- Transcripts ----------
async function saveTranscript(t) {
  await pool.query(
    `INSERT INTO transcripts (business_id, call_id, customer_phone, transcript, messages, recording_url, ended_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (call_id) DO UPDATE SET transcript = EXCLUDED.transcript,
     messages = EXCLUDED.messages, recording_url = EXCLUDED.recording_url, ended_reason = EXCLUDED.ended_reason`,
    [t.businessId, t.callId, t.phone, t.transcript, JSON.stringify(t.messages || []), t.recordingUrl, t.endedReason]);
}
async function listTranscripts(businessId) {
  const { rows } = await pool.query(
    `SELECT call_id, customer_phone, transcript, ended_reason, recording_url, created_at
     FROM transcripts WHERE business_id = $1 ORDER BY created_at DESC LIMIT 100`, [businessId]);
  return rows;
}

module.exports = {
  pool, createBusiness, getBusinessByEmail, getBusiness, updateBusiness,
  getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getOrder, getOrderView, setPaymentUrl, mutate, listOrders, setFulfilment,
  saveTranscript, listTranscripts,
};
