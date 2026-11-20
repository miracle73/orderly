// Showcase media: photos and videos a business uploads; visible ones appear as reels on its customer page.
// Browsers upload straight to S3 with a short-lived presigned URL (Lambda never handles the file).
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pool } = require('./store');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET = () => process.env.MEDIA_BUCKET;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const MAX = { image: 10 * 1024 * 1024, video: 60 * 1024 * 1024 };
const LIMIT = 40; // items per business
const fail = m => Object.assign(new Error(m), { status: 400 });
const urlOf = key => `https://${BUCKET()}.s3.amazonaws.com/${key}`;
const view = m => ({ id: m.id, kind: m.kind, caption: m.caption, visible: m.visible, url: urlOf(m.s3_key), createdAt: m.created_at });

async function uploadUrl(bid, { contentType, size }) {
  if (!BUCKET()) throw fail('Media uploads are not set up yet');
  const ext = TYPES[contentType];
  if (!ext) throw fail('Upload a JPG, PNG, WEBP or GIF photo, or an MP4, WEBM or MOV video');
  const kind = contentType.startsWith('video/') ? 'video' : 'image';
  if (!(size > 0) || size > MAX[kind]) throw fail(kind === 'video' ? 'Videos must be 60 MB or smaller' : 'Photos must be 10 MB or smaller');
  const { rows: [c] } = await pool.query('SELECT count(*)::int n FROM media WHERE business_id=$1', [bid]);
  if (c.n >= LIMIT) throw fail(`You can have up to ${LIMIT} photos and videos. Delete some to add more.`);
  const key = `media/${bid}/${crypto.randomUUID()}.${ext}`;
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: 600 });
  return { uploadUrl: url, key, kind };
}

async function register(bid, { key, kind, caption }) {
  if (!String(key || '').startsWith(`media/${bid}/`) || !['image', 'video'].includes(kind)) throw fail('Invalid upload');
  const { rows: [m] } = await pool.query(
    'INSERT INTO media (business_id, s3_key, kind, caption) VALUES ($1,$2,$3,$4) ON CONFLICT (s3_key) DO UPDATE SET caption = EXCLUDED.caption RETURNING *',
    [bid, key, kind, String(caption || '').slice(0, 140) || null]);
  return view(m);
}

const list = async (bid, onlyVisible = false) => (await pool.query(
  `SELECT * FROM media WHERE business_id=$1 ${onlyVisible ? 'AND visible' : ''} ORDER BY created_at DESC`, [bid])).rows.map(view);

async function update(bid, id, { visible, caption }) {
  const { rows: [m] } = await pool.query(
    'UPDATE media SET visible = COALESCE($1, visible), caption = COALESCE($2, caption) WHERE id=$3 AND business_id=$4 RETURNING *',
    [typeof visible === 'boolean' ? visible : null, caption === undefined ? null : String(caption).slice(0, 140), id, bid]);
  if (!m) throw fail('Not found');
  return view(m);
}

async function remove(bid, id) {
  const { rows: [m] } = await pool.query('DELETE FROM media WHERE id=$1 AND business_id=$2 RETURNING s3_key', [id, bid]);
  if (m) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: m.s3_key })).catch(e => console.error('s3 delete', e.message));
}

module.exports = { uploadUrl, register, list, update, remove };
