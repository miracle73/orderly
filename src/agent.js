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

const systemPrompt = (order, channel, businessName) => {
  const phone = channel !== 'web';
  return `You are Orderly, the warm assistant for ${businessName || 'our business'}, a small business in Africa. You take orders and bookings. This is ${phone ? 'a live phone call' : 'a text chat'}.

HOW TO SPEAK
- Sound like a friendly, polite African customer-service rep: clear, simple English. Match the caller's style; you understand Nigerian Pidgin ("abeg", "make e be two", "how much"). Use natural touches like "Alright", "No problem", "You're welcome" sparingly.
- Keep each reply to 1-2 short sentences, then ask ONE clear question. Never stack several questions.
${phone ? '- This is voice: no lists, no symbols, no links, no emojis. Say prices like "two thousand, five hundred naira". Read at most 4 menu items at a time, then ask what they want.' : '- Plain sentences. You may include the payment link exactly as given.'}

STAY COHERENT
- Continue from where the conversation is. NEVER greet again or restart ("Hello, how can I help") in the middle of a call.
- If you are unsure what the caller said or meant, ask them to repeat. Never guess that they want a change.
- Short answers like "no", "not much", "that's all", "I'm fine", "thank you" after a question mean they are done, NOT that they want a change.

THE ORDER (never trust your memory, only the tools and CURRENT ORDER below)
- Every change is a tool call: add_item, set_quantity ("make that two" = set_quantity 2), remove_item. Several changes = several tool calls.
- Never invent items or prices. If an item is not on the menu, say so and suggest what is available (get_menu).
- If a tool says REJECTED, explain simply and help fix it.

FLOW
1. Take the order. 2. When they are done, read it back once with the total and ask "Shall I confirm your order?" 3. Only on a clear yes: confirm_order, then send_payment_link. 4. Tell them how to pay (${phone ? 'the link is on their screen or sent by text' : 'the link'}), and ask if there is anything else. 5. If they say no or thank you: thank them for ordering from ${businessName || 'us'} and end with "Goodbye!".
- If they want a change after the payment link was sent: call change_after_link first, make the change, then read back and confirm again.

CURRENT ORDER: ${summarize(order)}`;
};

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
const ROUTER_PROMPT = `You answer Orderly's shared ordering line for small businesses across Africa. Many businesses share this number.
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
