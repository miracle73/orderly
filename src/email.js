// Transactional email via Resend. Without RESEND_API_KEY emails are logged (local dev).
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const naira = k => `₦${(k / 100).toLocaleString('en-NG')}`;
const app = () => process.env.FRONTEND_URL || 'https://orderly-ebon.vercel.app';

async function send(to, subject, body) {
  const html = `<div style="background:#f6f4ef;padding:24px 0"><div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:14px;padding:28px;color:#1c1c1c">
    <div style="font-weight:bold;font-size:18px;margin-bottom:18px"><span style="display:inline-block;background:#ff7a1a;color:#1a0d03;border-radius:8px;padding:4px 8px;margin-right:6px">📞</span>Orderly</div>
    ${body}<p style="color:#999;font-size:12px;margin-top:28px">Orderly · AI phone ordering for small businesses</p></div></div>`;
  if (!process.env.RESEND_API_KEY) return console.log(`[email stub] to=${to} subject=${subject}`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Orderly <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// Never let an email failure break signup, ordering or payment.
const safe = p => p.catch(e => console.error('email failed:', e.message));

const button = (href, text) => `<p><a href="${href}" style="display:inline-block;background:#ff7a1a;color:#1a0d03;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">${text}</a></p>`;
const itemsTable = order => `<table style="width:100%;border-collapse:collapse;margin:14px 0">${order.items.map(i =>
  `<tr><td style="padding:6px 0">${i.qty} × ${esc(i.name)}</td><td style="text-align:right">${naira(i.qty * i.priceKobo)}</td></tr>`).join('')}
  <tr><td style="padding:8px 0;border-top:1px solid #eee;font-weight:bold">Total</td><td style="text-align:right;border-top:1px solid #eee;font-weight:bold">${naira(order.totalKobo)}</td></tr></table>`;

const sendVerification = (to, businessName, link) => send(to, 'Verify your email for Orderly',
  `<h2 style="margin:0 0 10px">Welcome, ${esc(businessName)} 👋</h2><p>Confirm your email to start taking orders with your AI receptionist.</p>
   ${button(link, 'Verify my email')}<p style="color:#777;font-size:13px">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`);

const sendWelcome = b => safe(send(b.email, `${b.name} is on Orderly 🎉`,
  `<h2 style="margin:0 0 10px">You're verified!</h2><p>Three steps and your phone line starts taking orders:</p>
   <ol><li>Add your menu</li><li>Add the bank account you want to be paid into</li><li>Get your phone number</li></ol>${button(`${app()}/dashboard.html`, 'Open my dashboard')}`));

const sendOrderConfirmed = (b, orderId, order, customer) => safe(send(b.email, `New order #${orderId} · ${naira(order.totalKobo)}`,
  `<h2 style="margin:0 0 6px">New order #${orderId}</h2><p style="color:#555;margin:0">From ${esc(customer || 'a customer')} · waiting for payment</p>
   ${itemsTable(order)}${button(`${app()}/dashboard.html`, 'View on dashboard')}`));

const sendPaymentReceived = (b, orderId, order, customer) => safe(send(b.email, `💰 Paid: order #${orderId} · ${naira(order.totalKobo)}`,
  `<h2 style="margin:0 0 6px">Payment received for order #${orderId}</h2><p style="color:#555;margin:0">From ${esc(customer || 'a customer')} · start preparing it now</p>
   ${itemsTable(order)}${button(`${app()}/dashboard.html`, 'Open kitchen board')}`));

module.exports = { send, sendVerification, sendWelcome, sendOrderConfirmed, sendPaymentReceived };
