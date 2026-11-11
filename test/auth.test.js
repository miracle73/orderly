const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
process.env.APP_SECRET = 'test-secret';
const a = require('../src/auth');

const signedBody = body => {
  const sigKey = crypto.createHash('sha256').update('token:test-secret').digest();
  const sig = crypto.createHmac('sha256', sigKey).update(body).digest('base64url');
  return `${body}.${sig}`;
};

const withInvalidSignature = token => {
  const [body, sig] = token.split('.');
  const replacement = sig[0] === 'a' ? 'b' : 'a';
  return `${body}.${replacement}${sig.slice(1)}`;
};

test('password, token, encryption round-trip', () => {
  const h = a.hashPassword('hunter22!');
  assert.ok(a.checkPassword('hunter22!', h));
  assert.ok(!a.checkPassword('wrong', h));
  const t = a.signToken({ bid: 'b1' });
  assert.equal(a.verifyToken(t).bid, 'b1');
  assert.equal(a.verifyToken(t.slice(0, -2) + 'xx'), null);
  assert.equal(a.decrypt(a.encrypt('sk_test_abc')), 'sk_test_abc');
});

test('rejects malformed JSON and invalid payload structures', () => {
  assert.doesNotThrow(() => a.verifyToken(signedBody(Buffer.from('{bad').toString('base64url'))));
  assert.equal(a.verifyToken(signedBody(Buffer.from('{bad').toString('base64url'))), null);
  assert.equal(a.verifyToken(signedBody(Buffer.from('null').toString('base64url'))), null);
  assert.equal(a.verifyToken(signedBody(Buffer.from(JSON.stringify([])).toString('base64url'))), null);
  assert.equal(a.verifyToken(signedBody(Buffer.from(JSON.stringify({ bid: 'b1' })).toString('base64url'))), null);
  assert.equal(a.verifyToken(signedBody(Buffer.from(JSON.stringify({ bid: '', exp: Date.now() / 1000 + 60 })).toString('base64url'))), null);
  assert.equal(a.verifyToken(signedBody(Buffer.from(JSON.stringify({ bid: 'b1', exp: 'future' })).toString('base64url'))), null);
  assert.equal(a.verifyToken(`${a.signToken({ bid: 'b1' })}.extra`), null);
});

test('rejects expired tokens and invalid signatures', () => {
  assert.equal(a.verifyToken(a.signToken({ bid: 'b1' }, -1)), null);
  assert.equal(a.verifyToken(withInvalidSignature(a.signToken({ bid: 'b1' }))), null);
});
