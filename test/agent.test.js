const test = require('node:test');
const assert = require('node:assert');
const { runAgent } = require('../src/agent');
const { newOrder } = require('../src/orderMachine');

test('agent executes tool calls then replies', async () => {
  const calls = [];
  const script = [
    { role: 'assistant', content: '', tool_calls: [
      { id: 't1', function: { name: 'add_item', arguments: '{"item":"jollof"}' } },
      { id: 't2', function: { name: 'set_quantity', arguments: '{"item":"jollof","quantity":2}' } },
    ] },
    { role: 'assistant', content: 'Two jollof rice. Anything else?' },
  ];
  let seen;
  const out = await runAgent([{ role: 'system', content: 'ignored' }, { role: 'user', content: 'jollof, actually make that two' }],
    { callId: 'c1' }, {
      llm: async (msgs) => { seen = msgs; return script.shift(); },
      runTool: async (name, args) => { calls.push([name, args]); return 'OK'; },
      getOrder: async () => newOrder(),
    });
  assert.equal(out.reply, 'Two jollof rice. Anything else?');
  assert.deepEqual(calls.map(c => c[0]), ['add_item', 'set_quantity']);
  assert.equal(seen.filter(m => m.role === 'system').length, 1);
  assert.equal(seen.filter(m => m.role === 'tool').length, 2);
});

test('agent stops after max steps', async () => {
  const out = await runAgent([{ role: 'user', content: 'hi' }], { callId: 'c' }, {
    llm: async () => ({ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'get_order', arguments: '{}' } }] }),
    runTool: async () => 'OK', getOrder: async () => newOrder(),
  });
  assert.equal(out.steps.length, 8);
});
