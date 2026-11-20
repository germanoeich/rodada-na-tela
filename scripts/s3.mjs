// Minimal S3 (SigV4) client for Cloudflare R2. Zero dependencies.
// Reads S3_ACCESS_KEY, S3_SECRET_KEY, S3_API_URL, S3_BUCKET_NAME from the
// environment, falling back to a local .env file (never committed).

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i < 1 || line.trim().startsWith('#')) continue;
      const k = line.slice(0, i).trim();
      if (!env[k]) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return env;
}

export function s3Config() {
  const env = loadEnv();
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY || !env.S3_API_URL || !env.S3_BUCKET_NAME) return null;
  return {
    accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY,
    origin: new URL(env.S3_API_URL).origin, bucket: env.S3_BUCKET_NAME,
    region: env.S3_REGION || 'auto',
  };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// key: object key ('' for the bucket itself). query: e.g. { cors: '' }.
export async function s3Request(cfg, { method = 'GET', key = '', query = {}, body = '', headers = {} } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const uri = '/' + [cfg.bucket, ...key.split('/').filter((s) => s !== '')].map(enc).join('/');
  const qs = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&');
  const host = new URL(cfg.origin).host;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(payload);

  const signed = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(signed).sort();
  const canonical = [method, uri, qs, names.map((n) => n + ':' + signed[n] + '\n').join(''), names.join(';'), payloadHash].join('\n');
  const scope = [day, cfg.region, 's3', 'aws4_request'].join('/');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = ['aws4_request'].reduce(hmac, hmac(hmac(hmac('AWS4' + cfg.secretKey, day), cfg.region), 's3'));
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');

  return fetch(cfg.origin + uri + (qs ? '?' + qs : ''), {
    method,
    headers: {
      ...headers,
      'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
      authorization: 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKey + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + signature,
    },
    body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : payload,
    signal: AbortSignal.timeout(30000),
  });
}

export async function putObject(cfg, key, body, contentType, cacheControl) {
  const res = await s3Request(cfg, { method: 'PUT', key, body, headers: { 'content-type': contentType, 'cache-control': cacheControl || 'no-cache' } });
  if (!res.ok) throw new Error('S3 PUT ' + key + ' answered HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
}
