// Makes agent replies sound natural when spoken by the phone voice (Nigerian English).
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : '');
  if (!h) return rest;
  return `${ONES[h]} hundred${r ? ' and ' + rest : ''}`;
}

// 9500 -> "nine thousand, five hundred"; 2,350,000 -> "two million, three hundred and fifty thousand"
function numberToWords(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) { parts.push(`${under1000(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n) parts.push(parts.length && n < 100 ? `and ${under1000(n)}` : under1000(n));
  return parts.join(', ').replace(', and', ' and');
}

const nairaWords = (whole, kobo) => {
  const n = Number(String(whole).replace(/,/g, ''));
  const k = kobo ? Number(kobo.padEnd(2, '0')) : 0;
  return `${numberToWords(n)} naira${k ? ` and ${numberToWords(k)} kobo` : ''}`;
};

// For the phone voice: amounts in words, no links, no markdown or symbols the voice would read out.
function forSpeech(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the payment link')
    .replace(/(?:₦|NGN\s?|N(?=\d))\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g, (_, w, k) => nairaWords(w, k))
    .replace(/(\d+)\s*[x×]\s+/gi, '$1 ')
    .replace(/[*_#`>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { numberToWords, forSpeech };
