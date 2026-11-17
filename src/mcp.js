// Orderly MCP server (Model Context Protocol, Streamable HTTP, stateless JSON responses).
// Lets a business owner run their shop from an AI assistant (Claude, ChatGPT, Cursor…).
// Auth: per-business API key created in Setup → "Connect AI assistants".
const store = require('./store');

const naira = k => `₦${(k / 100).toLocaleString('en-NG')}`;
const FULFILMENT = ['new', 'preparing', 'ready', 'delivered'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  { name: 'get_sales_summary', description: 'Paid orders and revenue for today or the last N days.',
    inputSchema: obj({ days: { type: 'integer', minimum: 1, maximum: 90, description: '1 = today (default)' } }) },
  { name: 'list_orders', description: 'Recent orders with items, totals, payment status and kitchen status.',
    inputSchema: obj({ status: { type: 'string', enum: ['building', 'confirmed', 'awaiting_payment', 'paid', 'cancelled'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
  { name: 'update_order_status', description: 'Move a PAID order through the kitchen: new → preparing → ready → delivered.',
    inputSchema: obj({ order_id: { type: 'integer' }, status: { type: 'string', enum: FULFILMENT } }, ['order_id', 'status']) },
  { name: 'list_menu', description: 'All menu items with ids, prices and availability.', inputSchema: obj() },
  { name: 'add_menu_item', description: 'Add a new item to the menu.',
    inputSchema: obj({ name: { type: 'string' }, price_naira: { type: 'number', exclusiveMinimum: 0 }, other_names: { type: 'string', description: 'Comma-separated names customers use' } }, ['name', 'price_naira']) },
  { name: 'update_menu_item', description: 'Rename, re-price, or mark a menu item available / sold out.',
    inputSchema: obj({ item_id: { type: 'integer' }, name: { type: 'string' }, price_naira: { type: 'number', exclusiveMinimum: 0 }, available: { type: 'boolean' } }, ['item_id']) },
  { name: 'get_recent_calls', description: 'Transcripts of recent customer conversations.',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 10 } }) },
];

const fmtOrder = o => `#${o.id} · ${o.state.items.map(i => `${i.qty}× ${i.name}`).join(', ') || 'empty'} · ${naira(o.state.items.reduce((s, i) => s + i.qty * i.priceKobo, 0))} · ${o.status}${o.status === 'paid' ? ` · kitchen: ${o.fulfilment}` : ''} · ${o.customer_phone || (o.call_id.startsWith('web_') ? 'web' : 'phone')} · ${new Date(o.updated_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function callTool(b, name, a = {}) {
  switch (name) {
    case 'get_sales_summary': {
      const days = Math.min(Math.max(parseInt(a.days || 1, 10), 1), 90);
      const { rows: [r] } = await store.pool.query(
        `SELECT count(*)::int AS n, coalesce(sum((state->>'totalKobo')::int),0)::bigint AS kobo FROM orders
         WHERE business_id=$1 AND status='paid' AND updated_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' - ($2::int - 1) * interval '1 day'`, [b.id, days]);
      const { rows: [w] } = await store.pool.query(`SELECT count(*)::int AS n FROM orders WHERE business_id=$1 AND status='awaiting_payment'`, [b.id]);
      return `${days === 1 ? 'Today' : `Last ${days} days`} (Lagos time): ${r.n} paid order(s), revenue ${naira(Number(r.kobo))}. ${w.n} order(s) awaiting payment.`;
    }
    case 'list_orders': {
      let rows = await store.listOrders(b.id);
      if (a.status) rows = rows.filter(o => o.status === a.status);
      rows = rows.slice(0, Math.min(a.limit || 10, 50));
      return rows.length ? rows.map(fmtOrder).join('\n') : 'No matching orders.';
    }
    case 'update_order_status': {
      const { rows: [o] } = await store.pool.query('SELECT status FROM orders WHERE id=$1 AND business_id=$2', [a.order_id, b.id]);
      if (!o) throw new Error(`Order #${a.order_id} not found`);
      if (o.status !== 'paid') throw new Error(`Order #${a.order_id} is not paid yet (status: ${o.status})`);
      await store.setFulfilment(b.id, a.order_id, a.status);
      return `Order #${a.order_id} is now "${a.status}".`;
    }
    case 'list_menu': {
      const m = await store.getMenu(b.id);
      return m.length ? m.map(i => `[id ${i.id}] ${i.name} · ${naira(i.priceKobo)} · ${i.available ? 'available' : 'SOLD OUT'}${i.aliases.length ? ` · also: ${i.aliases.join(', ')}` : ''}`).join('\n') : 'The menu is empty.';
    }
    case 'add_menu_item': {
      try {
        await store.addMenuItem(b.id, { name: a.name, priceKobo: Math.round(Number(a.price_naira) * 100), aliases: String(a.other_names || '').split(',').map(s => s.trim()).filter(Boolean) });
      } catch (e) { throw new Error(e.code === '23505' ? `"${a.name}" is already on the menu` : e.message); }
      return `Added ${a.name} at ${naira(Math.round(Number(a.price_naira) * 100))}.`;
    }
    case 'update_menu_item': {
      const before = (await store.getMenu(b.id)).find(i => i.id === a.item_id);
      if (!before) throw new Error(`Menu item ${a.item_id} not found`);
      try {
        await store.updateMenuItem(b.id, a.item_id, { name: a.name, available: a.available, priceKobo: a.price_naira !== undefined ? Math.round(Number(a.price_naira) * 100) : undefined });
      } catch (e) { throw new Error(e.code === '23505' ? 'Another item already has that name' : e.message); }
      const after = (await store.getMenu(b.id)).find(i => i.id === a.item_id);
      return `Updated: ${after.name} · ${naira(after.priceKobo)} · ${after.available ? 'available' : 'SOLD OUT'}.`;
    }
    case 'get_recent_calls': {
      const t = (await store.listTranscripts(b.id)).slice(0, Math.min(a.limit || 3, 10));
      return t.length ? t.map(c => `— ${c.customer_phone || 'customer'} · ${new Date(c.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC\n${c.transcript || '(no transcript)'}`).join('\n\n') : 'No calls yet.';
    }
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
  }
}

// Handles one JSON-RPC message; returns the response object (or null for notifications).
async function handle(b, msg) {
  const { id, method, params = {} } = msg || {};
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (id === undefined || id === null) return null; // notification (e.g. notifications/initialized)
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'orderly', version: '1.0.0' },
        instructions: `You are helping the owner of "${b.name}" run their Orderly shop. Prices are in Nigerian naira. Only paid orders can move through the kitchen.` });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call':
      try { return ok({ content: [{ type: 'text', text: await callTool(b, params.name, params.arguments || {}) }] }); }
      catch (e) { if (e.rpc) return err(e.rpc, e.message); return ok({ content: [{ type: 'text', text: e.message }], isError: true }); }
    default: return err(-32601, `Method not found: ${method}`);
  }
}

module.exports = { handle, TOOLS };
