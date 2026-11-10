// SMS sender. Plug in your provider (Termii, Africa's Talking, etc.) via SMS_WEBHOOK_URL.
async function send(to, text) {
  if (!process.env.SMS_WEBHOOK_URL) {
    console.log(`[sms stub] to=${to}: ${text}`);
    return;
  }
  const res = await fetch(process.env.SMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SMS_API_KEY || ''}` },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) throw new Error(`SMS failed: ${res.status}`);
}

module.exports = { send };
