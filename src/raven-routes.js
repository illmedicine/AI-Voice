// Raven-specific REST endpoints: Google sign-in, profile, rooms, history.

import { Router } from 'express';
import { verifyGoogleIdToken } from './google.js';
import { createSession, requireRavenAuth, revokeSession } from './sessions.js';
import {
  upsertUser,
  getUser,
  updateUserPreferences,
  createChat,
  getChat,
  joinChat,
  leaveChat,
  appendMessage,
  listChatsForUser,
  renameChat,
  deleteChat,
  MAX_MEMBERS,
} from './store.js';
import { grokChat } from './grok.js';
import { elevenlabsTTS, contentTypeForFormat } from './elevenlabs.js';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { dbEnabled } from './db.js';

export const ravenRouter = Router();

const googleAudiences = (process.env.GOOGLE_CLIENT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Diagnostic: lets the Android app and developers verify backend wiring
// without exposing secrets. Safe to call unauthenticated.
ravenRouter.get('/raven/config', (_req, res) => {
  res.json({
    devMode: process.env.RAVEN_DEV_MODE === '1',
    googleConfigured: googleAudiences.length > 0,
    googleAudienceCount: googleAudiences.length,
    dbBackend: dbEnabled ? 'postgres' : 'json',
    maxMembers: 10,
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
  });
});

// ---------- Auth ----------

// POST /raven/auth/google  { id_token }
ravenRouter.post('/raven/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body || {};
    const payload = await verifyGoogleIdToken(id_token, googleAudiences);
    const user = upsertUser({
      id: `google:${payload.sub}`,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture,
    });
    const token = createSession(user.id);
    res.json({ token, user });
  } catch (err) {
    res.status(401).json({ error: 'Google sign-in failed', detail: String(err.message || err) });
  }
});

ravenRouter.post('/raven/auth/logout', requireRavenAuth, (req, res) => {
  revokeSession(req.ravenToken);
  res.json({ ok: true });
});

// POST /raven/auth/dev  { name? }
// Debug-only sign-in that mints a session for a synthetic guest user.
// Enabled when RAVEN_DEV_MODE=1 on the server. Use to bypass Play Protect
// blocks while prototyping on emulators that can't pass Google Sign-In.
ravenRouter.post('/raven/auth/dev', (req, res) => {
  if (process.env.RAVEN_DEV_MODE !== '1') {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    const rawName = String((req.body && req.body.name) || '').trim().slice(0, 40);
    const suffix = Math.random().toString(36).slice(2, 8);
    const id = `guest:${suffix}`;
    const name = rawName || `Guest ${suffix.toUpperCase()}`;
    const user = upsertUser({
      id,
      email: `${suffix}@guest.raven.local`,
      name,
      picture: '',
    });
    const token = createSession(user.id);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: 'guest sign-in failed', detail: String(err.message || err) });
  }
});

// ---------- Profile ----------

ravenRouter.get('/raven/me', requireRavenAuth, (req, res) => {
  const user = getUser(req.ravenUserId);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ user });
});

ravenRouter.patch('/raven/me/preferences', requireRavenAuth, (req, res) => {
  const user = updateUserPreferences(req.ravenUserId, req.body || {});
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ user });
});

// ---------- Chats ----------

ravenRouter.get('/raven/chats', requireRavenAuth, (req, res) => {
  res.json({ chats: listChatsForUser(req.ravenUserId) });
});

ravenRouter.post('/raven/chats', requireRavenAuth, (req, res) => {
  const { title } = req.body || {};
  const chat = createChat({ ownerId: req.ravenUserId, title });
  res.json({ chat });
});

ravenRouter.get('/raven/chats/:id', requireRavenAuth, (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  if (!chat.members.includes(req.ravenUserId))
    return res.status(403).json({ error: 'not a member' });
  res.json({ chat });
});

ravenRouter.post('/raven/chats/:id/join', requireRavenAuth, (req, res) => {
  const result = joinChat(req.params.id, req.ravenUserId);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Chat not found' });
  if (result.error === 'full')
    return res.status(409).json({ error: `Chat is full (max ${MAX_MEMBERS} members).` });
  res.json({ chat: result.chat });
});

ravenRouter.post('/raven/chats/:id/leave', requireRavenAuth, (req, res) => {
  const chat = leaveChat(req.params.id, req.ravenUserId);
  if (!chat) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

ravenRouter.patch('/raven/chats/:id', requireRavenAuth, (req, res) => {
  const result = renameChat(req.params.id, req.ravenUserId, (req.body || {}).title);
  if (!result) return res.status(404).json({ error: 'not found' });
  if (result.error === 'forbidden') return res.status(403).json({ error: 'owner only' });
  res.json({ chat: result });
});

ravenRouter.delete('/raven/chats/:id', requireRavenAuth, (req, res) => {
  const result = deleteChat(req.params.id, req.ravenUserId);
  if (!result) return res.status(404).json({ error: 'not found' });
  if (result.error === 'forbidden') return res.status(403).json({ error: 'owner only' });
  res.json({ ok: true });
});

// Append an arbitrary message to a chat (used by clients to log their own lines
// when they haven't gone through the Grok endpoint).
ravenRouter.post('/raven/chats/:id/messages', requireRavenAuth, (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  if (!chat.members.includes(req.ravenUserId))
    return res.status(403).json({ error: 'not a member' });
  const { role = 'user', text = '', name = '', mood = 'neutral' } = req.body || {};
  const msg = appendMessage(chat.id, {
    role,
    text: String(text).slice(0, 4000),
    name: String(name).slice(0, 60),
    mood: String(mood).slice(0, 20),
    userId: role === 'user' ? req.ravenUserId : undefined,
  });
  res.json({ message: msg });
});

// Ask Raven within a chat: records the user turn, calls Grok with room
// context, records Raven's reply, returns { user, assistant }.
ravenRouter.post('/raven/chats/:id/ask', requireRavenAuth, async (req, res) => {
  try {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: 'not found' });
    if (!chat.members.includes(req.ravenUserId))
      return res.status(403).json({ error: 'not a member' });

    const user = getUser(req.ravenUserId);
    const { prompt, name } = req.body || {};
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: '`prompt` required' });

    const userMsg = appendMessage(chat.id, {
      role: 'user',
      text: String(prompt).slice(0, 4000),
      name: String(name || user?.name || 'User').slice(0, 60),
      userId: req.ravenUserId,
    });

    // Build context from recent chat history (last ~20 turns).
    const history = chat.messages.slice(-20).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content:
        m.role === 'assistant'
          ? m.text
          : `${m.name || 'Someone'}: ${m.text}`,
    }));

    const system =
      `You are Raven, a shared AI companion for a small group chat (up to ${MAX_MEMBERS} people). ` +
      `Address participants by name when helpful. Keep replies concise unless asked. ` +
      config.xai.systemPrompt;

    const { text, mood } = await grokChat({ messages: history, system });
    const botMsg = appendMessage(chat.id, {
      role: 'assistant',
      name: 'Raven',
      text,
      mood,
    });

    res.json({ user: userMsg, assistant: botMsg });
  } catch (err) {
    req.log?.error({ err }, 'raven ask failed');
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- TTS ----------
// Stream Raven's voice to a signed-in client. Uses ElevenLabs under the hood.
// POST /raven/tts  { text, voiceId? }
// Returns: audio/mpeg (mp3) stream by default.
ravenRouter.post('/raven/tts', requireRavenAuth, async (req, res) => {
  try {
    const { text, voiceId } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: '`text` required' });
    }
    // Strip "[mood: x]" prefix the model emits — TTS shouldn't speak it.
    const clean = String(text).replace(/^\s*\[mood:[^\]]*\]\s*/i, '').trim();
    if (!clean) return res.status(400).json({ error: 'empty after cleanup' });

    const upstream = await elevenlabsTTS({
      text: clean,
      voiceId: voiceId || config.elevenlabs.voiceId,
    });
    res.setHeader('Content-Type', contentTypeForFormat(config.elevenlabs.outputFormat));
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(upstream.body).on('error', (e) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'tts stream error', detail: String(e?.message || e) });
      } else {
        res.end();
      }
    }).pipe(res);
  } catch (err) {
    req.log?.error({ err }, 'raven tts failed');
    res.status(err.status || 500).json({ error: err.message });
  }
});
