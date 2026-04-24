// Google ID token verification using Google's public JWKS.
// No SDK dependency — we fetch JWKS, cache it, and verify RS256 signatures.

import crypto from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

let jwksCache = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks() {
  const now = Date.now();
  if (jwksCache.keys.length && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const json = await res.json();
  jwksCache = { keys: json.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function jwkToPem(jwk) {
  // Node supports importing JWK directly via createPublicKey.
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verify a Google ID token. Returns decoded payload on success, throws otherwise.
 * @param {string} idToken
 * @param {string[]} allowedAudiences - your Google OAuth client IDs
 */
export async function verifyGoogleIdToken(idToken, allowedAudiences = []) {
  if (!idToken || typeof idToken !== 'string') throw new Error('missing id_token');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error('unsupported alg');
  if (!ISSUERS.has(payload.iss)) throw new Error('bad issuer');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 60) throw new Error('token expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('token not yet valid');

  if (allowedAudiences.length) {
    if (!allowedAudiences.includes(payload.aud)) throw new Error('bad audience');
  }

  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found');

  const pubKey = jwkToPem(jwk);
  const data = Buffer.from(`${headerB64}.${payloadB64}`);
  const sig = b64urlDecode(sigB64);
  const ok = crypto.verify('RSA-SHA256', data, pubKey, sig);
  if (!ok) throw new Error('bad signature');

  return payload;
}
