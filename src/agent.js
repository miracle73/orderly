// Agent loop: the model plans and calls tools; the server executes them against the state machine
// and feeds results back until the model produces a spoken reply. The model never holds order state:
// the live order is re-read from the DB and injected every turn.
const { summarize } = require('./orderMachine');

const fn = (name, description, properties = {}, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const item = { type: 'string', description: 'Menu item name as the caller said it' };

const TOOLS = [
  fn('get_menu', 'List available items and prices.'),
  fn('get_order', 'Read the current order and total.'),
  fn('add_item', 'Add an item (adds to any existing quantity).', { item, quantity: { type: 'integer', minimum: 1 } }, ['item']),
  fn('set_quantity', 'Set exact quantity of an item already in the order. 0 removes it. Use for "make that two".', { item, quantity: { type: 'integer', minimum: 0 } }, ['item', 'quantity']),
  fn('remove_item', 'Remove an item from the order.', { item }, ['item']),
  fn('confirm_order', 'Lock the order. Only after reading it back and the caller clearly says yes.'),
  fn('send_payment_link', 'Create a Paystack payment link and send it to the caller. Only after CONFIRMED.'),
  fn('change_after_link', 'Caller wants to change the order after the payment link was sent.'),
  fn('cancel_order', 'Cancel the whole order. Only if the caller explicitly asks.'),
];

const systemPrompt = (order, channel, businessName) => `You are Orderly, the friendly phone ordering assistant for ${businessName || 'our restaurant'} in Nigeria.
Speak naturally and briefly (1-2 short sentences; this is ${channel === 'web' ? 'a chat' : 'a phone call'}). Understand Nigerian English and Pidgin.
Rules:
- You do NOT remember the order. The CURRENT ORDER below and tool results are the only truth.
- Every change must be a tool call. "Actually make that two" => set_quantity 2. Multiple changes => multiple tool calls.
- Never invent items, prices or totals. Call get_menu if unsure.
- If a tool says REJECTED, explain simply and help the caller fix it.
- When the caller is done: read back the order with total, ask "Shall I confirm?", and only on a clear yes call confirm_order, then send_payment_link.
- If they change after confirming, make the change, then read back and confirm again.
CURRENT ORDER: ${summarize(order)}`;

async function runAgent(history, ctx, deps) {
  const { llm, runTool, getOrder } = deps;
  const convo = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-30)
    .map(({ role, content }) => ({ role, content }));
  const messages = [{ role: 'system', content: systemPrompt(await getOrder(ctx.callId), ctx.channel, ctx.business?.name) }, ...convo];
  const steps = [];

  for (let i = 0; i < 8; i++) {
    const msg = await llm(messages, TOOLS);
    messages.push(msg);
    if (!msg.tool_calls?.length) return { reply: msg.content.trim() || 'Sorry, could you say that again?', steps };
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* bad JSON -> empty args, tool will reject */ }
      const result = String(await runTool(tc.function.name, args, ctx));
      steps.push({ tool: tc.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  return { reply: 'Sorry, give me one moment. Could you repeat that?', steps };
}

// Shared phone line: find out which business the caller wants, then hand the call to that business's agent.
const ROUTER_TOOLS = [fn('select_business', 'Connect the caller to a business by its name or 4-digit code, exactly as the caller said it.',
  { query: { type: 'string' } }, ['query'])];
const ROUTER_PROMPT = `You answer Orderly's shared ordering line in Nigeria. Many businesses share this number.
Your only job: find out which business the caller wants to order from (they can say its name or its 4-digit code), then call select_business.
Be warm and brief (1 sentence). If several businesses match, read the options and ask which one. If none match, ask them to repeat the name or code.
Never take an order yourself.`;

async function runRouter(history, ctx, deps) {
  const { llm, findBusinesses, connect } = deps;
  const convo = history.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map(({ role, content }) => ({ role, content }));
  const messages = [{ role: 'system', content: ROUTER_PROMPT }, ...convo];
  for (let i = 0; i < 4; i++) {
    const msg = await llm(messages, ROUTER_TOOLS);
    messages.push(msg);
    if (!msg.tool_calls?.length) return { reply: msg.content.trim() || 'Which business would you like to order from?' };
    for (const tc of msg.tool_calls) {
      let query = '';
      try { query = JSON.parse(tc.function.arguments || '{}').query; } catch { /* empty query -> no match */ }
      const found = await findBusinesses(query);
      if (found.length === 1) return connect(found[0]);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: found.length
        ? `Several match: ${found.map(b => `${b.name} (code ${b.short_code})`).join('; ')}. Ask which one.`
        : `No business matches "${query}". Ask the caller to repeat the business name or its 4-digit code.` });
    }
  }
  return { reply: 'Sorry, which business would you like to order from?' };
}

module.exports = { runAgent, runRouter, TOOLS, systemPrompt };
