// Password hashing, signed session tokens, and encryption of stored secrets (Paystack keys).
const crypto = require('crypto');

const key = label => crypto.createHash('sha256').update(`${label}:${process.env.APP_SECRET}`).digest();
const b64 = s => Buffer.from(s).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}

function signToken(payload, ttlSec = 7 * 86400) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${crypto.createHmac('sha256', key('token')).update(body).digest('base64url')}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', key('token')).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url'));
  return p.exp > Date.now() / 1000 ? p : null;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key('enc'), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('hex')).join(':');
}

function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, ct] = blob.split(':').map(h => Buffer.from(h, 'hex'));
  const d = crypto.createDecipheriv('aes-256-gcm', key('enc'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function requireAuth(req, res, next) {
  const p = verifyToken((req.get('authorization') || '').replace(/^Bearer /, ''));
  if (!p) return res.status(401).json({ error: 'Please log in' });
  req.businessId = p.bid;
  next();
}

module.exports = { hashPassword, checkPassword, signToken, verifyToken, encrypt, decrypt, requireAuth };
