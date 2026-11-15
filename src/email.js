// Transactional email via Resend. Without RESEND_API_KEY the link is logged (local dev).
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendVerification(to, businessName, link) {
  if (!process.env.RESEND_API_KEY) return console.log(`[email stub] verify ${to}: ${link}`);
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1c1c1c">
    <h2 style="margin:0 0 12px">Welcome to Orderly, ${esc(businessName)} 👋</h2>
    <p>Confirm your email to start taking orders with your AI receptionist.</p>
    <p><a href="${link}" style="display:inline-block;background:#ff7a1a;color:#1a0d03;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Verify my email</a></p>
    <p style="color:#777;font-size:13px">This link expires in 24 hours. If you didn't sign up, ignore this email.</p></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Orderly <onboarding@resend.dev>', to: [to], subject: 'Verify your email for Orderly', html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

module.exports = { sendVerification };
