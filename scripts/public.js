// Local dev: run the server behind a public HTTPS tunnel (cloudflared) so Vapi and Paystack can reach it.
// After it starts, press "Re-sync voice agent" in Setup so the business's assistant points at the tunnel.
require('dotenv').config();
const { spawn } = require('child_process');
const app = require('../src/server');

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate']);
  let done = false;
  const onData = d => {
    const m = !done && String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    done = true;
    process.env.PUBLIC_URL = m[0];
    console.log(`\n✔ Public URL: ${m[0]}\n  Open ${m[0]}/login.html, then Setup → Re-sync voice agent.\n`);
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('exit', c => { console.error('cloudflared exited', c); process.exit(1); });
  process.on('SIGINT', () => { cf.kill(); process.exit(0); });
});
