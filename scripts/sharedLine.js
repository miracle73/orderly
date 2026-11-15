// Creates/updates the shared-line "router" assistant and attaches SHARED_PHONE_NUMBER (a number on your Vapi account) to it.
// Usage: node scripts/sharedLine.js   (after deploy; reads the backend URL from public/config.js)
require('dotenv').config();
const fs = require('fs');
const { VAPI_API_KEY, VAPI_SECRET, SHARED_PHONE_NUMBER } = process.env;
const base = fs.readFileSync(__dirname + '/../public/config.js', 'utf8').match(/'(https:[^']+)'/)[1];
const api = async (method, path, body) => {
  const r = await fetch('https://api.vapi.ai' + path, { method, headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j;
};
(async () => {
  if (!SHARED_PHONE_NUMBER) throw new Error('Set SHARED_PHONE_NUMBER in .env, e.g. +16502520200');
  const config = {
    name: 'Orderly Shared Line',
    firstMessage: 'Hello, thanks for calling Orderly! Which business would you like to order from? You can say its name or its 4-digit code.',
    model: { provider: 'custom-llm', url: `${base}/llm/${VAPI_SECRET}/shared`, model: 'orderly', messages: [{ role: 'system', content: 'Handled server-side by Orderly.' }] },
    server: { url: `${base}/vapi/shared`, secret: VAPI_SECRET },
    serverMessages: ['end-of-call-report'],
    endCallPhrases: ['goodbye', 'bye bye'],
    voice: { provider: 'azure', voiceId: 'en-NG-EzinneNeural' },
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' },
  };
  const existing = (await api('GET', '/assistant?limit=100')).find(a => a.name === config.name);
  const assistant = existing ? await api('PATCH', `/assistant/${existing.id}`, config) : await api('POST', '/assistant', config);
  const num = (await api('GET', '/phone-number?limit=100')).find(n => n.number === SHARED_PHONE_NUMBER);
  if (!num) throw new Error(`${SHARED_PHONE_NUMBER} is not on your Vapi account`);
  await api('PATCH', `/phone-number/${num.id}`, { assistantId: assistant.id, name: 'Orderly Shared Line' });
  console.log(`✔ ${SHARED_PHONE_NUMBER} now answers as the shared line (assistant ${assistant.id})`);
})().catch(e => { console.error('✖', e.message); process.exit(1); });
