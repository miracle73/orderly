// Every email Orderly sends. Each template returns { subject, html, text }.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const naira = k => `₦${(k / 100).toLocaleString('en-NG')}`;
const app = () => process.env.FRONTEND_URL || 'https://orderly-ebon.vercel.app';
const BRAND = '#ff7a1a';

function layout({ preheader, title, intro, body = '', cta, footnote }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c">
  <tr><td style="background:#0f1411;padding:20px 28px">
    <span style="display:inline-block;background:${BRAND};color:#1a0d03;border-radius:9px;padding:5px 9px;font-weight:bold">📞</span>
    <span style="color:#f4efe6;font-weight:bold;font-size:18px;vertical-align:middle;margin-left:8px">Orderly</span></td></tr>
  <tr><td style="padding:30px 28px 8px">
    <h1 style="margin:0 0 10px;font-size:23px;line-height:1.25">${title}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444">${intro}</p>
    ${body}
    ${cta ? `<p style="margin:22px 0 6px"><a href="${cta.href}" style="display:inline-block;background:${BRAND};color:#1a0d03;padding:13px 22px;border-radius:11px;text-decoration:none;font-weight:bold;font-size:15px">${esc(cta.label)}</a></p>` : ''}
    ${footnote ? `<p style="margin:18px 0 0;font-size:12.5px;color:#888;line-height:1.5">${footnote}</p>` : ''}
  </td></tr>
  <tr><td style="padding:22px 28px 26px;font-size:12px;color:#999;border-top:1px solid #f0ede6">
    Orderly · AI phone ordering for small businesses in Nigeria<br>You're receiving this because you have an Orderly business account.</td></tr>
</table></td></tr></table></body></html>`;
}

const orderTable = order => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0;border:1px solid #eee;border-radius:12px;font-size:14.5px">
  ${order.items.map(i => `<tr><td style="padding:10px 14px">${i.qty} × ${esc(i.name)}</td><td align="right" style="padding:10px 14px">${naira(i.qty * i.priceKobo)}</td></tr>`).join('')}
  <tr><td style="padding:12px 14px;border-top:1px solid #eee;font-weight:bold">Total</td><td align="right" style="padding:12px 14px;border-top:1px solid #eee;font-weight:bold">${naira(order.totalKobo)}</td></tr></table>`;
const orderText = order => order.items.map(i => `${i.qty} x ${i.name}  ${naira(i.qty * i.priceKobo)}`).join('\n') + `\nTotal: ${naira(order.totalKobo)}`;

module.exports = {
  verifyEmail: ({ businessName, link }) => ({
    subject: 'Verify your email for Orderly',
    html: layout({ preheader: 'One click to activate your AI receptionist', title: `Welcome, ${esc(businessName)} 👋`,
      intro: 'Confirm your email address to activate your Orderly account.', cta: { href: link, label: 'Verify my email' },
      footnote: "This link expires in 24 hours. If you didn't create an Orderly account, you can ignore this email." }),
    text: `Welcome to Orderly, ${businessName}!\n\nVerify your email: ${link}\n\nThis link expires in 24 hours.`,
  }),

  welcome: ({ businessName, shortCode, sharedNumber }) => ({
    subject: `${businessName} is on Orderly 🎉`,
    html: layout({ preheader: 'Three quick steps to start taking orders', title: "You're verified!",
      intro: 'Three quick steps and your customers can start ordering by phone:',
      body: `<ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.9;color:#333"><li>Add your menu</li><li>Add the bank account you want to be paid into</li><li>Share your number with customers</li></ol>
        ${sharedNumber ? `<div style="margin:18px 0 0;padding:16px;border-radius:12px;background:#fff6ee;border:1px solid #ffd9b8;font-size:15px">Customers call <b>${esc(sharedNumber)}</b> and say <b>“${esc(businessName)}”</b> or your code <b style="color:${BRAND};font-size:18px">${esc(shortCode)}</b>.</div>` : ''}`,
      cta: { href: `${app()}/dashboard.html`, label: 'Open my dashboard' } }),
    text: `You're verified! Add your menu, add your bank account, then share your number.${sharedNumber ? `\nCustomers call ${sharedNumber} and say "${businessName}" or code ${shortCode}.` : ''}\n${app()}/dashboard.html`,
  }),

  newOrder: ({ businessName, orderId, order, customer }) => ({
    subject: `🛎️ New order #${orderId} · ${naira(order.totalKobo)}`,
    html: layout({ preheader: `${order.items.length} item(s), waiting for payment`, title: `New order #${orderId}`,
      intro: `${esc(customer || 'A customer')} just confirmed an order with ${esc(businessName)}. A payment link has been sent; we'll email you again once it's paid.`,
      body: orderTable(order), cta: { href: `${app()}/dashboard.html`, label: 'View order' } }),
    text: `New order #${orderId} from ${customer || 'a customer'} (awaiting payment)\n\n${orderText(order)}\n\n${app()}/dashboard.html`,
  }),

  paymentReceived: ({ orderId, order, customer }) => ({
    subject: `💰 Paid: order #${orderId} · ${naira(order.totalKobo)}`,
    html: layout({ preheader: 'Start preparing this order now', title: `Order #${orderId} is paid`,
      intro: `${esc(customer || 'The customer')} has paid. Start preparing the order and update its status on your kitchen board.`,
      body: orderTable(order), cta: { href: `${app()}/dashboard.html`, label: 'Open kitchen board' },
      footnote: 'Paystack pays the money into your bank account on its normal payout schedule.' }),
    text: `Order #${orderId} is PAID by ${customer || 'the customer'}. Start preparing it.\n\n${orderText(order)}\n\n${app()}/dashboard.html`,
  }),

  payoutUpdated: ({ accountName, bankName, last4 }) => ({
    subject: 'Your payout bank account was updated',
    html: layout({ preheader: `Payouts now go to ${bankName} ••••${last4}`, title: 'Payout account updated',
      intro: 'Payments from your customers will now be paid into:',
      body: `<div style="padding:16px;border-radius:12px;background:#f6f6f4;font-size:15px;line-height:1.6"><b>${esc(accountName)}</b><br>${esc(bankName)} ••••${esc(last4)}</div>`,
      footnote: "If you didn't make this change, log in and update your bank account immediately, then contact us." }),
    text: `Payouts now go to ${accountName}, ${bankName} ****${last4}. If you didn't make this change, log in and update it immediately.`,
  }),

  passwordReset: ({ businessName, link }) => ({
    subject: 'Reset your Orderly password',
    html: layout({ preheader: 'Use this link to choose a new password', title: 'Reset your password',
      intro: `We got a request to reset the password for ${esc(businessName)}'s Orderly account.`, cta: { href: link, label: 'Choose a new password' },
      footnote: "This link expires in 1 hour. If you didn't ask for this, ignore this email and your password stays the same." }),
    text: `Reset your Orderly password: ${link}

This link expires in 1 hour. If you didn't ask for this, ignore this email.`,
  }),

  passwordChanged: ({ businessName }) => ({
    subject: 'Your Orderly password was changed',
    html: layout({ preheader: 'Security notice for your account', title: 'Password changed',
      intro: `The password for ${esc(businessName)}'s Orderly account was just changed.`,
      cta: { href: `${app()}/login.html`, label: 'Log in' },
      footnote: "If you didn't do this, reset your password right away with \"Forgot password?\" on the login page." }),
    text: `The password for ${businessName}'s Orderly account was just changed. If this wasn't you, reset it now at ${app()}/login.html`,
  }),
};
