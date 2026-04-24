// Lightweight opaque session tokens tied to userIds. In memory only —
// clients re-auth via Google if the server restarts.

import crypto from 'node:crypto';

const sessions = new Map(); // token -> { userId, createdAt, lastUsedAt }
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(token, { userId, createdAt: now, lastUsedAt: now });
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastUsedAt > TTL_MS) {
    sessions.delete(token);
    return null;
  }
  s.lastUsedAt = Date.now();
  return s.userId;
}

export function revokeSession(token) {
  sessions.delete(token);
}

// Middleware: require a Raven user session (Bearer or x-raven-token).
export function requireRavenAuth(req, res, next) {
  const token =
    req.get('x-raven-token') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const userId = getSessionUser(token);
  if (!userId) return res.status(401).json({ error: 'Not signed in.' });
  req.ravenUserId = userId;
  req.ravenToken = token;
  next();
}
