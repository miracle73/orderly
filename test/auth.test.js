const test = require('node:test');
const assert = require('node:assert');
process.env.APP_SECRET = 'test-secret';
const a = require('../src/auth');

test('password, token, encryption round-trip', () => {
  const h = a.hashPassword('hunter22!');
  assert.ok(a.checkPassword('hunter22!', h));
  assert.ok(!a.checkPassword('wrong', h));
  const t = a.signToken({ bid: 'b1' });
  assert.equal(a.verifyToken(t).bid, 'b1');
  assert.equal(a.verifyToken(t.slice(0, -2) + 'xx'), null);
  assert.equal(a.decrypt(a.encrypt('sk_test_abc')), 'sk_test_abc');
});
