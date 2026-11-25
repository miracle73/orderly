// One Vapi assistant + phone number per business. The assistant's LLM URL carries the business id,
// so every voice turn is routed to that business's menu, orders and Paystack account.
async function api(method, path, body) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${[].concat(json.message || JSON.stringify(json)).join('; ')}`);
  return json;
}

const assistantConfig = (b, baseUrl, keyterms = []) => ({
  name: `Orderly ${b.name}`.slice(0, 40),
  firstMessage: `Hello, thanks for calling ${b.name}! What would you like to order today?`,
  model: {
    provider: 'custom-llm', url: `${baseUrl}/llm/${process.env.VAPI_SECRET}/${b.id}`, model: 'orderly',
    messages: [{ role: 'system', content: 'Handled server-side by Orderly.' }],
  },
  server: { url: `${baseUrl}/vapi/${b.id}`, secret: process.env.VAPI_SECRET },
  serverMessages: ['end-of-call-report'],
  endCallPhrases: ['goodbye', 'bye bye'],
  voice: { provider: 'vapi', voiceId: 'Savannah' },
  startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: 'livekit' } },
  stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1 },
  backgroundDenoisingEnabled: true,
  // nova-3 + the business's own menu words = much better listening on noisy lines.
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en', keyterm: [b.name, ...keyterms].slice(0, 50) },
});

// Creates or updates the business's assistant; returns its id.
async function syncAssistant(b, baseUrl, keyterms) {
  if (b.vapi_assistant_id) {
    await api('PATCH', `/assistant/${b.vapi_assistant_id}`, assistantConfig(b, baseUrl, keyterms));
    return b.vapi_assistant_id;
  }
  return (await api('POST', '/assistant', assistantConfig(b, baseUrl, keyterms))).id;
}

// Free Vapi number (US) by default, or import the business's own Twilio number (e.g. a Nigerian +234 line).
async function provisionNumber(b, { areaCode, twilioNumber, twilioAccountSid, twilioAuthToken } = {}) {
  const base = { assistantId: b.vapi_assistant_id, name: b.name.slice(0, 40) };
  if (twilioNumber) {
    const p = await api('POST', '/phone-number', { ...base, provider: 'twilio', number: twilioNumber, twilioAccountSid, twilioAuthToken });
    return { id: p.id, number: p.number };
  }
  // Vapi requires an area code; try the requested one, then common US codes with free inventory.
  const codes = [...new Set([areaCode, '415', '650', '213', '646', '312', '206', '512', '305'].filter(Boolean).map(String))];
  let lastErr;
  for (const code of codes) {
    try {
      const p = await api('POST', '/phone-number', { ...base, provider: 'vapi', numberDesiredAreaCode: code });
      return { id: p.id, number: p.number || p.sipUri || 'pending' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

module.exports = { syncAssistant, provisionNumber, assistantConfig };
