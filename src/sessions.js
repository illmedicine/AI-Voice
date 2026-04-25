// Opaque session tokens tied to userIds. Hydrated from Postgres on boot
// when DATABASE_URL is set, so sessions survive Railway redeploys. Falls
// back to memory-only behavior in local dev.

import crypto from 'node:crypto';
import {
  dbEnabled,
  loadAllSessions,
  insertSessionRow,
  touchSessionRow,
  deleteSessionRow,
  deleteExpiredSessions,
} from './db.js';

const sessions = new Map(); // token -> { userId, createdAt, lastUsedAt }
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOUCH_THROTTLE_MS = 60 * 1000;

export async function hydrateSessions(logger) {
  if (!dbEnabled) return;
  const cutoff = Date.now() - TTL_MS;
  try { await deleteExpiredSessions(cutoff); } catch (e) { logger?.warn?.({ err: e }, '[sessions] purge expired failed'); }
  const rows = await loadAllSessions();
  for (const r of rows) {
    sessions.set(r.token, { userId: r.userId, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt });
  }
  logger?.info?.(`[sessions] hydrated ${sessions.size} sessions from postgres`);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const row = { userId, createdAt: now, lastUsedAt: now };
  sessions.set(token, row);
  if (dbEnabled) {
    insertSessionRow({ token, ...row }).catch((e) => console.error('[sessions] insert', e));
  }
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastUsedAt > TTL_MS) {
    sessions.delete(token);
    if (dbEnabled) deleteSessionRow(token).catch(() => {});
    return null;
  }
  // Throttle touch writes to once per minute per token.
  if (now - s.lastUsedAt > TOUCH_THROTTLE_MS) {
    s.lastUsedAt = now;
    if (dbEnabled) touchSessionRow(token, now).catch(() => {});
  } else {
    s.lastUsedAt = now;
  }
  return s.userId;
}

export function revokeSession(token) {
  sessions.delete(token);
  if (dbEnabled) deleteSessionRow(token).catch(() => {});
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
