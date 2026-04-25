// User profiles + chat history. Memory-resident, hydrated from Postgres on
// boot when DATABASE_URL is set; otherwise persists to a JSON file. The
// public API stays synchronous — DB writes happen as fire-and-forget tasks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  dbEnabled,
  loadAllUsers,
  loadAllChats,
  upsertUserRow,
  upsertChatRow,
  deleteChatRow,
} from './db.js';

const DATA_DIR = process.env.RAVEN_DATA_DIR || path.resolve(process.cwd(), '.raven-data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let users = dbEnabled ? {} : loadJson(USERS_FILE, {});
let chats = dbEnabled ? {} : loadJson(CHATS_FILE, {});

let flushTimer = null;
function scheduleFlush() {
  if (dbEnabled) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { saveJson(USERS_FILE, users); } catch {}
    try { saveJson(CHATS_FILE, chats); } catch {}
  }, 250);
  flushTimer.unref?.();
}

function persistUser(u) {
  if (!dbEnabled) return scheduleFlush();
  upsertUserRow(u).catch((e) => console.error('[store] upsertUser', e));
}
function persistChat(c) {
  if (!dbEnabled) return scheduleFlush();
  if (!c) return;
  upsertChatRow(c).catch((e) => console.error('[store] upsertChat', e));
}
function persistChatDelete(id) {
  if (!dbEnabled) return scheduleFlush();
  deleteChatRow(id).catch((e) => console.error('[store] deleteChat', e));
}

export async function hydrateStore(logger) {
  if (!dbEnabled) return;
  users = await loadAllUsers();
  chats = await loadAllChats();
  logger?.info?.(`[store] hydrated ${Object.keys(users).length} users, ${Object.keys(chats).length} chats from postgres`);
}

// ---------- Users ----------
export function upsertUser({ id, email, name, picture }) {
  if (!id) throw new Error('user id required');
  const now = Date.now();
  const existing = users[id] || {};
  users[id] = {
    id,
    email: email ?? existing.email ?? '',
    name: name ?? existing.name ?? '',
    picture: picture ?? existing.picture ?? '',
    preferences: existing.preferences ?? { voiceId: '', mood: 'neutral', theme: 'dark' },
    voiceId: existing.voiceId ?? '',
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  };
  persistUser(users[id]);
  return users[id];
}

export function getUser(id) {
  return users[id] || null;
}

export function updateUserPreferences(id, patch) {
  const u = users[id];
  if (!u) return null;
  u.preferences = { ...(u.preferences || {}), ...(patch || {}) };
  u.updatedAt = Date.now();
  persistUser(u);
  return u;
}

// ---------- Chats ----------
export const MAX_MEMBERS = 10;

function shortId() {
  return crypto.randomBytes(6).toString('base64url').replace(/[_-]/g, '').slice(0, 8).toUpperCase();
}

export function createChat({ ownerId, title }) {
  if (!ownerId) throw new Error('ownerId required');
  let id;
  do { id = shortId(); } while (chats[id]);
  const now = Date.now();
  chats[id] = {
    id,
    ownerId,
    title: title || 'New Raven Chat',
    members: [ownerId],
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messages: [],
  };
  persistChat(chats[id]);
  return chats[id];
}

export function getChat(id) {
  return chats[id] || null;
}

export function joinChat(id, userId) {
  const chat = chats[id];
  if (!chat) return { error: 'not_found' };
  if (chat.members.includes(userId)) return { chat };
  if (chat.members.length >= MAX_MEMBERS) return { error: 'full' };
  chat.members.push(userId);
  chat.updatedAt = Date.now();
  persistChat(chat);
  return { chat };
}

export function leaveChat(id, userId) {
  const chat = chats[id];
  if (!chat) return null;
  chat.members = chat.members.filter((m) => m !== userId);
  chat.updatedAt = Date.now();
  persistChat(chat);
  return chat;
}

export function appendMessage(id, msg) {
  const chat = chats[id];
  if (!chat) return null;
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    ts: Date.now(),
    ...msg,
  };
  chat.messages.push(entry);
  if (chat.messages.length > 500) chat.messages.splice(0, chat.messages.length - 500);
  chat.lastMessageAt = entry.ts;
  chat.updatedAt = entry.ts;
  persistChat(chat);
  return entry;
}

export function listChatsForUser(userId, { limit = 50 } = {}) {
  return Object.values(chats)
    .filter((c) => c.members.includes(userId))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit)
    .map(summarize);
}

function summarize(c) {
  const last = c.messages[c.messages.length - 1];
  return {
    id: c.id,
    title: c.title,
    ownerId: c.ownerId,
    memberCount: c.members.length,
    maxMembers: MAX_MEMBERS,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: last ? String(last.text || '').slice(0, 120) : '',
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
  };
}

export function renameChat(id, userId, title) {
  const chat = chats[id];
  if (!chat) return null;
  if (chat.ownerId !== userId) return { error: 'forbidden' };
  chat.title = String(title || '').slice(0, 120) || chat.title;
  chat.updatedAt = Date.now();
  persistChat(chat);
  return chat;
}

export function deleteChat(id, userId) {
  const chat = chats[id];
  if (!chat) return null;
  if (chat.ownerId !== userId) return { error: 'forbidden' };
  delete chats[id];
  persistChatDelete(id);
  return { ok: true };
}
