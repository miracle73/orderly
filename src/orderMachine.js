// Deterministic order state machine. Pure: no I/O, no model. Every change is validated here.
// States: building -> confirmed -> awaiting_payment -> paid. Any state before paid can be cancelled.
// Changing the basket after confirming drops back to building (customer must re-confirm).

const MAX_QTY = 50;

function newOrder() {
  return { status: 'building', items: [], totalKobo: 0, paymentRef: null };
}

function findMenuItem(menu, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  return menu.find(m => m.available && (m.name.toLowerCase() === q || (m.aliases || []).some(a => a.toLowerCase() === q))) || null;
}

function total(items) {
  return items.reduce((s, i) => s + i.priceKobo * i.qty, 0);
}

function validQty(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_QTY;
}

const fail = (error) => ({ ok: false, error });

function apply(order, action, menu) {
  const { type } = action;
  const o = { ...order, items: order.items.map(i => ({ ...i })) };
  const editable = o.status === 'building' || o.status === 'confirmed';

  if (o.status === 'paid') return fail('Order is already paid and cannot be changed.');
  if (o.status === 'cancelled') return fail('Order was cancelled.');

  switch (type) {
    case 'add_item': {
      if (!editable) return fail('Order is awaiting payment; cancel payment first to change it.');
      const m = findMenuItem(menu, action.item);
      if (!m) return fail(`"${action.item}" is not on the menu or is unavailable.`);
      const qty = action.quantity ?? 1;
      if (!validQty(qty)) return fail(`Quantity must be a whole number from 1 to ${MAX_QTY}.`);
      const line = o.items.find(i => i.menuId === m.id);
      if (line) {
        if (!validQty(line.qty + qty)) return fail(`Max ${MAX_QTY} per item.`);
        line.qty += qty;
      } else o.items.push({ menuId: m.id, name: m.name, priceKobo: m.priceKobo, qty });
      break;
    }
    case 'set_quantity': {
      if (!editable) return fail('Order is awaiting payment; cancel payment first to change it.');
      const m = findMenuItem(menu, action.item);
      const line = m && o.items.find(i => i.menuId === m.id);
      if (!line) return fail(`"${action.item}" is not in the order.`);
      if (action.quantity === 0) o.items = o.items.filter(i => i !== line);
      else if (!validQty(action.quantity)) return fail(`Quantity must be a whole number from 0 to ${MAX_QTY}.`);
      else line.qty = action.quantity;
      break;
    }
    case 'remove_item': {
      if (!editable) return fail('Order is awaiting payment; cancel payment first to change it.');
      const m = findMenuItem(menu, action.item);
      const before = o.items.length;
      o.items = o.items.filter(i => !m || i.menuId !== m.id);
      if (o.items.length === before) return fail(`"${action.item}" is not in the order.`);
      break;
    }
    case 'confirm_order': {
      if (o.status !== 'building') return fail(`Cannot confirm from status "${o.status}".`);
      if (!o.items.length) return fail('Order is empty.');
      o.status = 'confirmed';
      o.totalKobo = total(o.items);
      return { ok: true, order: o };
    }
    case 'start_payment': {
      if (o.status !== 'confirmed') return fail('Order must be confirmed before payment.');
      if (!action.reference) return fail('Missing payment reference.');
      o.status = 'awaiting_payment';
      o.paymentRef = action.reference;
      return { ok: true, order: o };
    }
    case 'cancel_payment': {
      if (o.status !== 'awaiting_payment') return fail('No payment in progress.');
      o.status = 'building';
      o.paymentRef = null;
      break;
    }
    case 'payment_success': {
      if (o.status !== 'awaiting_payment') return fail('No payment expected.');
      if (action.reference !== o.paymentRef) return fail('Payment reference mismatch.');
      if (action.amountKobo !== o.totalKobo) return fail('Paid amount does not match order total.');
      o.status = 'paid';
      return { ok: true, order: o };
    }
    case 'cancel_order': {
      o.status = 'cancelled';
      return { ok: true, order: o };
    }
    default:
      return fail(`Unknown action "${type}".`);
  }

  // Any basket edit invalidates a prior confirmation.
  o.status = 'building';
  o.totalKobo = total(o.items);
  return { ok: true, order: o };
}

function summarize(o) {
  const lines = o.items.map(i => `${i.qty} x ${i.name}`).join(', ') || 'nothing yet';
  return `${lines}. Total: ₦${(total(o.items) / 100).toLocaleString('en-NG')}. Status: ${o.status}.`;
}

module.exports = { newOrder, apply, summarize, findMenuItem, MAX_QTY };
