const test = require('node:test');
const assert = require('node:assert');
const { numberToWords, forSpeech } = require('../src/speech');

test('numbers in words', () => {
  assert.equal(numberToWords(9500), 'nine thousand, five hundred');
  assert.equal(numberToWords(2500), 'two thousand, five hundred');
  assert.equal(numberToWords(1050), 'one thousand and fifty');
  assert.equal(numberToWords(250000), 'two hundred and fifty thousand');
  assert.equal(numberToWords(1200000), 'one million, two hundred thousand');
  assert.equal(numberToWords(15), 'fifteen');
});

test('replies made speakable', () => {
  assert.equal(forSpeech('Total is ₦9,500. Shall I confirm?'), 'Total is nine thousand, five hundred naira. Shall I confirm?');
  assert.equal(forSpeech('3 x Chicken and 2 × White Rice'), '3 Chicken and 2 White Rice');
  assert.equal(forSpeech('Pay here: [Pay Now](https://checkout.paystack.com/x)'), 'Pay here: Pay Now');
  assert.equal(forSpeech('**Done**, that is ₦500.50'), 'Done, that is five hundred naira and fifty kobo');
});
