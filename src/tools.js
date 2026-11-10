// Agent tool handlers. The model only calls these; all state lives in Postgres via the state machine.
// ctx = { businessId, business, callId, phone, channel }
const crypto = require('crypto');
const store = require('./store');
const paystack = require('./paystack');
const sms = require('./sms');
const { decrypt } = require('./auth');
const { summarize } = require('./orderMachine');

const naira = k => `₦${(k / 100).toLocaleString('en-NG')}`;
const reply = r => r.ok ? `OK. Order now: ${summarize(r.order)}` : `REJECTED: ${r.error} Current order: ${summarize(r.order)}`;
const mutate = (ctx, action) => store.mutate(ctx, action);

const handlers = {
  async get_menu(_, ctx) {
    const menu = (await store.getMenu(ctx.businessId)).filter(m => m.available);
    return menu.length ? menu.map(m => `${m.name}: ${naira(m.priceKobo)}`).join('; ') : 'The menu is empty right now.';
  },
  async get_order(_, ctx) { return summarize(await store.getOrder(ctx.callId)); },
  async add_item({ item, quantity }, ctx) { return reply(await mutate(ctx, { type: 'add_item', item, quantity: quantity ?? 1 })); },
  async set_quantity({ item, quantity }, ctx) { return reply(await mutate(ctx, { type: 'set_quantity', item, quantity })); },
  async remove_item({ item }, ctx) { return reply(await mutate(ctx, { type: 'remove_item', item })); },
  async confirm_order(_, ctx) {
    const r = await mutate(ctx, { type: 'confirm_order' });
    return r.ok ? `CONFIRMED. ${summarize(r.order)} Now call send_payment_link.` : reply(r);
  },
  async cancel_order(_, ctx) { return reply(await mutate(ctx, { type: 'cancel_order' })); },
  async change_after_link(_, ctx) { return reply(await mutate(ctx, { type: 'cancel_payment' })); },

  async send_payment_link(_, ctx) {
    const secret = decrypt(ctx.business.paystack_secret_enc);
    if (!secret) return 'This business has not set up online payment. Tell the caller their order is confirmed and they can pay on pickup or delivery.';
    const current = await store.getOrder(ctx.callId);
    if (current.status === 'awaiting_payment') return `Payment link was already sent for ${naira(current.totalKobo)}.`;
    const reference = `ord_${crypto.randomBytes(8).toString('hex')}`;
    const r = await mutate(ctx, { type: 'start_payment', reference });
    if (!r.ok) return reply(r);
    try {
      const digits = String(ctx.phone || '').replace(/\D/g, '') || `guest${Date.now()}`;
      const tx = await paystack.initialize(secret, {
        email: `${digits}@${process.env.CUSTOMER_EMAIL_DOMAIN || 'orderly.ng'}`,
        amountKobo: r.order.totalKobo, reference,
        metadata: { businessId: ctx.businessId, callId: ctx.callId, orderId: r.orderId },
      });
      await store.setPaymentUrl(ctx.callId, tx.authorization_url);
      const amt = naira(r.order.totalKobo);
      if (ctx.channel === 'web') return `Payment link for ${amt}: ${tx.authorization_url} (include this exact link in your reply).`;
      if (!ctx.phone) return `Payment link for ${amt} is now showing on the caller's screen. Ask them to tap Pay now.`;
      await sms.send(ctx.phone, `${ctx.business.name}: pay ${amt} for your order: ${tx.authorization_url}`);
      return `Payment link for ${amt} sent by SMS to the caller.`;
    } catch (e) {
      await mutate(ctx, { type: 'cancel_payment' });
      return `FAILED to create payment link (${e.message}). Apologise and offer to try again.`;
    }
  },
};

async function runTool(name, args, ctx) {
  const h = handlers[name];
  if (!h) return `Unknown tool ${name}.`;
  try {
    return await h(args || {}, ctx);
  } catch (e) {
    console.error('tool error', name, e);
    return 'SYSTEM ERROR. Apologise briefly and try again.';
  }
}

module.exports = { runTool, handlers };
