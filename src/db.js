// Postgres adapter. When DATABASE_URL is set, exposes a connected pool and
// helpers for loading/persisting Raven state. Otherwise, exports null so the
// rest of the app falls back to the JSON file store (local dev).

import pg from 'pg';

const { Pool } = pg;

const url = process.env.DATABASE_URL;
export const dbEnabled = !!url;

let pool = null;
let initPromise = null;

export function getPool() {
  if (!dbEnabled) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      // Railway internal Postgres uses a private network, no TLS required.
      // External hosts typically need ssl: { rejectUnauthorized: false }.
      ssl: /railway\.internal/.test(url) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] pool error', err);
    });
  }
  return pool;
}

export async function initDb(logger) {
  if (!dbEnabled) return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS raven_users (
        id           TEXT PRIMARY KEY,
        email        TEXT NOT NULL DEFAULT '',
        name         TEXT NOT NULL DEFAULT '',
        picture      TEXT NOT NULL DEFAULT '',
        voice_id     TEXT NOT NULL DEFAULT '',
        preferences  JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   BIGINT NOT NULL,
        updated_at   BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raven_chats (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL,
        title           TEXT NOT NULL,
        members         JSONB NOT NULL DEFAULT '[]'::jsonb,
        messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL,
        last_message_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raven_sessions (
        token         TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        last_used_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS raven_chats_last_msg_idx ON raven_chats (last_message_at DESC);
    `);
    logger?.info?.('[db] postgres ready');
    return true;
  })();
  return initPromise;
}

export async function loadAllUsers() {
  const p = getPool();
  if (!p) return {};
  const { rows } = await p.query('SELECT * FROM raven_users');
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      id: r.id,
      email: r.email,
      name: r.name,
      picture: r.picture,
      voiceId: r.voice_id,
      preferences: r.preferences || {},
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
  return out;
}

export async function loadAllChats() {
  const p = getPool();
  if (!p) return {};
  const { rows } = await p.query('SELECT * FROM raven_chats');
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      id: r.id,
      ownerId: r.owner_id,
      title: r.title,
      members: r.members || [],
      messages: r.messages || [],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastMessageAt: Number(r.last_message_at),
    };
  }
  return out;
}

export async function loadAllSessions() {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query('SELECT * FROM raven_sessions');
  return rows.map((r) => ({
    token: r.token,
    userId: r.user_id,
    createdAt: Number(r.created_at),
    lastUsedAt: Number(r.last_used_at),
  }));
}

export async function upsertUserRow(u) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO raven_users (id, email, name, picture, voice_id, preferences, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       email=EXCLUDED.email, name=EXCLUDED.name, picture=EXCLUDED.picture,
       voice_id=EXCLUDED.voice_id, preferences=EXCLUDED.preferences,
       updated_at=EXCLUDED.updated_at`,
    [u.id, u.email || '', u.name || '', u.picture || '', u.voiceId || '', u.preferences || {}, u.createdAt, u.updatedAt],
  );
}

export async function upsertChatRow(c) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO raven_chats (id, owner_id, title, members, messages, created_at, updated_at, last_message_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, members=EXCLUDED.members, messages=EXCLUDED.messages,
       updated_at=EXCLUDED.updated_at, last_message_at=EXCLUDED.last_message_at`,
    [c.id, c.ownerId, c.title, JSON.stringify(c.members), JSON.stringify(c.messages), c.createdAt, c.updatedAt, c.lastMessageAt],
  );
}

export async function deleteChatRow(id) {
  const p = getPool();
  if (!p) return;
  await p.query('DELETE FROM raven_chats WHERE id=$1', [id]);
}

export async function insertSessionRow(s) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO raven_sessions (token, user_id, created_at, last_used_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO NOTHING`,
    [s.token, s.userId, s.createdAt, s.lastUsedAt],
  );
}

export async function touchSessionRow(token, ts) {
  const p = getPool();
  if (!p) return;
  await p.query('UPDATE raven_sessions SET last_used_at=$2 WHERE token=$1', [token, ts]);
}

export async function deleteSessionRow(token) {
  const p = getPool();
  if (!p) return;
  await p.query('DELETE FROM raven_sessions WHERE token=$1', [token]);
}

export async function deleteExpiredSessions(cutoff) {
  const p = getPool();
  if (!p) return 0;
  const { rowCount } = await p.query('DELETE FROM raven_sessions WHERE last_used_at < $1', [cutoff]);
  return rowCount;
}
