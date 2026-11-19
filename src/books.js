// Bookings, cashflow ledger, accounting summary and receipts. Every query is scoped to one business.
const crypto = require('crypto');
const { pool } = require('./store');

const BOOKING_STATUS = ['booked', 'completed', 'cancelled', 'no_show'];
const fail = msg => Object.assign(new Error(msg), { status: 400 });
const kobo = n => Math.round(Number(n) * 100);

// ---------- Bookings ----------
async function listBookings(bid, { from, to } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE business_id=$1 AND starts_at >= coalesce($2::timestamptz, now() - interval '30 days')
     AND starts_at < coalesce($3::timestamptz, now() + interval '365 days') ORDER BY starts_at LIMIT 500`, [bid, from || null, to || null]);
  return rows;
}
async function addBooking(bid, { customerName, customerPhone, service, startsAt, priceNaira, notes }) {
  if (!String(customerName || '').trim() || !String(service || '').trim()) throw fail('Customer name and service are required');
  if (!startsAt || isNaN(new Date(startsAt))) throw fail('Choose a date and time');
  const amount = priceNaira ? kobo(priceNaira) : 0;
  if (!(amount >= 0)) throw fail('Price must be 0 or more');
  const { rows: [b] } = await pool.query(
    `INSERT INTO bookings (business_id, customer_name, customer_phone, service, starts_at, amount_kobo, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [bid, customerName.trim(), customerPhone || null, service.trim(), new Date(startsAt), amount, notes || null]);
  return b;
}
async function updateBooking(bid, id, { status }) {
  if (!BOOKING_STATUS.includes(status)) throw fail('Bad booking status');
  const { rows: [b] } = await pool.query('UPDATE bookings SET status=$1 WHERE id=$2 AND business_id=$3 RETURNING *', [status, id, bid]);
  if (!b) throw fail('Booking not found');
  return b;
}
const deleteBooking = (bid, id) => pool.query('DELETE FROM bookings WHERE id=$1 AND business_id=$2', [id, bid]);

// ---------- Ledger ----------
async function listTransactions(bid, days = 30) {
  const { rows } = await pool.query(
    `SELECT * FROM transactions WHERE business_id=$1 AND occurred_on > CURRENT_DATE - $2::int ORDER BY occurred_on DESC, id DESC LIMIT 500`, [bid, days]);
  return rows;
}
async function addTransaction(bid, { kind, amountNaira, category, note, occurredOn }) {
  if (!['income', 'expense'].includes(kind)) throw fail('Choose income or expense');
  const amount = kobo(amountNaira);
  if (!(amount > 0)) throw fail('Amount must be more than 0');
  const { rows: [t] } = await pool.query(
    `INSERT INTO transactions (business_id, kind, amount_kobo, category, note, occurred_on) VALUES ($1,$2,$3,$4,$5,coalesce($6::date, CURRENT_DATE)) RETURNING *`,
    [bid, kind, amount, String(category || 'Other').trim() || 'Other', note || null, occurredOn || null]);
  return t;
}
const deleteTransaction = (bid, id) => pool.query('DELETE FROM transactions WHERE id=$1 AND business_id=$2', [id, bid]);

// Income = paid orders + completed bookings + manual income. Expenses = manual expenses.
async function accounting(bid, days = 30) {
  const q = (sql, p = [bid, days]) => pool.query(sql, p).then(r => r.rows);
  const [[o], [bk], tx, daily] = await Promise.all([
    q(`SELECT count(*)::int n, coalesce(sum((state->>'totalKobo')::bigint),0)::bigint k FROM orders WHERE business_id=$1 AND status='paid' AND updated_at > now() - ($2::int * interval '1 day')`),
    q(`SELECT count(*)::int n, coalesce(sum(amount_kobo),0)::bigint k FROM bookings WHERE business_id=$1 AND status='completed' AND starts_at > now() - ($2::int * interval '1 day')`),
    q(`SELECT kind, category, sum(amount_kobo)::bigint k FROM transactions WHERE business_id=$1 AND occurred_on > CURRENT_DATE - $2::int GROUP BY kind, category ORDER BY k DESC`),
    q(`SELECT d::date AS day,
         (SELECT coalesce(sum((state->>'totalKobo')::bigint),0) FROM orders WHERE business_id=$1 AND status='paid' AND updated_at::date = d::date)
       + (SELECT coalesce(sum(amount_kobo),0) FROM bookings WHERE business_id=$1 AND status='completed' AND starts_at::date = d::date)
       + (SELECT coalesce(sum(amount_kobo),0) FROM transactions WHERE business_id=$1 AND kind='income' AND occurred_on = d::date) AS income,
         (SELECT coalesce(sum(amount_kobo),0) FROM transactions WHERE business_id=$1 AND kind='expense' AND occurred_on = d::date) AS expense
       FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, interval '1 day') d ORDER BY d`),
  ]);
  const sum = kind => tx.filter(t => t.kind === kind).reduce((s, t) => s + Number(t.k), 0);
  const income = Number(o.k) + Number(bk.k) + sum('income');
  const expenses = sum('expense');
  return {
    days, incomeKobo: income, expensesKobo: expenses, netKobo: income - expenses,
    orders: { count: o.n, kobo: Number(o.k) }, bookings: { count: bk.n, kobo: Number(bk.k) }, otherIncomeKobo: sum('income'),
    expensesByCategory: tx.filter(t => t.kind === 'expense').map(t => ({ category: t.category, kobo: Number(t.k) })),
    daily: daily.map(d => ({ day: d.day, income: Number(d.income), expense: Number(d.expense) })),
  };
}

// ---------- Receipts (shareable signed link, no login needed to view) ----------
const sig = id => crypto.createHmac('sha256', `receipt:${process.env.APP_SECRET}`).update(String(id)).digest('base64url').slice(0, 22);
const receiptToken = orderId => `${orderId}.${sig(orderId)}`;
async function receipt(token) {
  const [id, s] = String(token || '').split('.');
  if (!/^\d+$/.test(id || '') || !s || s.length !== 22 || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sig(id)))) return null;
  const { rows: [r] } = await pool.query(
    `SELECT o.id, o.state, o.status, o.payment_ref, o.customer_phone, o.updated_at, b.name, b.short_code, b.email
     FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=$1`, [id]);
  if (!r || r.status !== 'paid') return null;
  return { number: `RCP-${r.short_code || '0000'}-${String(r.id).padStart(5, '0')}`, orderId: r.id, business: { name: r.name, email: r.email },
    items: r.state.items, totalKobo: r.state.totalKobo, paidAt: r.updated_at, reference: r.payment_ref, customer: r.customer_phone };
}

module.exports = { listBookings, addBooking, updateBooking, deleteBooking, listTransactions, addTransaction, deleteTransaction, accounting, receiptToken, receipt };
