// All outgoing email. Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD) is the default; Resend is a fallback.
// Without either, emails are logged (local dev). Templates live in emailTemplates.js.
const nodemailer = require('nodemailer');
const T = require('./emailTemplates');

let gmail;
const transport = () => gmail || (gmail = nodemailer.createTransport({
  service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s/g, '') },
}));
const from = () => process.env.EMAIL_FROM || `Orderly <${process.env.GMAIL_USER || 'onboarding@resend.dev'}>`;

async function send(to, { subject, html, text }) {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return transport().sendMail({ from: from(), to, subject, html, text });
  }
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from(), to: [to], subject, html, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return;
  }
  console.log(`[email stub] to=${to} subject=${subject}`);
}

// Notifications must never break signup, ordering or payment.
const safe = p => p.catch(e => console.error('email failed:', e.message));
const shared = () => process.env.SHARED_PHONE_NUMBER || null;

module.exports = {
  send,
  sendVerification: (to, businessName, link) => send(to, T.verifyEmail({ businessName, link })),
  sendWelcome: b => safe(send(b.email, T.welcome({ businessName: b.name, shortCode: b.short_code, sharedNumber: shared() }))),
  sendOrderConfirmed: (b, orderId, order, customer) => safe(send(b.email, T.newOrder({ businessName: b.name, orderId, order, customer }))),
  sendPaymentReceived: (b, orderId, order, customer) => safe(send(b.email, T.paymentReceived({ orderId, order, customer }))),
  sendPayoutUpdated: b => safe(send(b.email, T.payoutUpdated({ accountName: b.account_name, bankName: b.bank_name, last4: String(b.account_number).slice(-4) }))),
};
