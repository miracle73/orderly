// OpenRouter (OpenAI-compatible) chat completion with tools.
async function chat(messages, tools) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Orderly',
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      messages, tools, tool_choice: 'auto', temperature: 0.3, max_tokens: 300,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.choices) throw new Error(`OpenRouter ${res.status}: ${body.error?.message || 'bad response'}`);
  const m = body.choices[0].message;
  return { role: 'assistant', content: m.content || '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
}

module.exports = { chat };
