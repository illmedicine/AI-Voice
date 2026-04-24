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
import { config } from './config.js';

export const ravenRouter = Router();

const googleAudiences = (process.env.GOOGLE_CLIENT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
