// Realtime presence + WebRTC signaling server.
//
// Clients connect at `wss://<host>/rt?key=<api-key>[&name=<display>]`. The
// server tracks who's online, broadcasts the user list, and relays WebRTC
// offers / answers / ICE candidates between peers. It also rebroadcasts
// "chat" and "speak" events so one participant's voice reply can play on
// every connected device (simple moderator / room mode).

import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSessionUser } from './sessions.js';
import { getChat, getUser, joinChat, appendMessage, MAX_MEMBERS } from './store.js';

/** @typedef {{ id:string, userId?:string, name:string, ws:import('ws').WebSocket, joinedAt:number, hasCamera:boolean, roomId?:string }} Peer */

const peers = new Map(); // peerId -> Peer
const rooms = new Map(); // roomId (chatId) -> Set<peerId>

function broadcast(obj, exceptId) {
  const json = JSON.stringify(obj);
  for (const [id, p] of peers) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) {
      try { p.ws.send(json); } catch {}
    }
  }
}

function broadcastRoom(roomId, obj, exceptPeerId) {
  const set = rooms.get(roomId);
  if (!set) return;
  const json = JSON.stringify(obj);
  for (const pid of set) {
    if (pid === exceptPeerId) continue;
    const p = peers.get(pid);
    if (p && p.ws.readyState === 1) {
      try { p.ws.send(json); } catch {}
    }
  }
}

function roomPeerList(roomId) {
  const set = rooms.get(roomId);
  if (!set) return [];
  return Array.from(set)
    .map((pid) => peers.get(pid))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      userId: p.userId,
      name: p.name,
      hasCamera: p.hasCamera,
      joinedAt: p.joinedAt,
    }));
}

function broadcastRoomPresence(roomId) {
  broadcastRoom(roomId, {
    type: 'room-presence',
    roomId,
    users: roomPeerList(roomId),
    count: rooms.get(roomId)?.size || 0,
  });
}

function sendTo(id, obj) {
  const p = peers.get(id);
  if (p && p.ws.readyState === 1) {
    try { p.ws.send(JSON.stringify(obj)); } catch {}
  }
}

function peerList() {
  return Array.from(peers.values()).map((p) => ({
    id: p.id,
    name: p.name,
    hasCamera: p.hasCamera,
    joinedAt: p.joinedAt,
  }));
}

function broadcastPresence() {
  const payload = { type: 'presence', users: peerList(), count: peers.size };
  broadcast(payload);
}

function authed(req) {
  // Accept either a Raven session token (preferred for the Android app) or
  // the legacy middleware API key via query string for the old web client.
  try {
    const url = new URL(req.url, 'http://x');
    const ravenToken = url.searchParams.get('raven');
    if (ravenToken) {
      const userId = getSessionUser(ravenToken);
      if (userId) return { userId };
    }
    if (config.apiKeys.length === 0) return { userId: null };
    const key = url.searchParams.get('key');
    if (key && config.apiKeys.includes(key)) return { userId: null };
  } catch {}
  return null;
}

export function attachRealtime(server, logger) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/rt')) {
      socket.destroy();
      return;
    }
    const auth = authed(req);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    req.ravenUserId = auth.userId || null;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const id = crypto.randomBytes(6).toString('hex');
    let name = 'guest';
    let roomId = null;
    try {
      const u = new URL(req.url, 'http://x');
      name = (u.searchParams.get('name') || '').slice(0, 40) || `guest-${id.slice(0, 4)}`;
      roomId = (u.searchParams.get('room') || '').slice(0, 32) || null;
    } catch {}

    const userId = req.ravenUserId || null;
    if (userId) {
      const u = getUser(userId);
      if (u?.name) name = u.name;
    }

    const peer = { id, userId, name, ws, joinedAt: Date.now(), hasCamera: false, roomId: null };
    peers.set(id, peer);

    // Auto-join the requested room if the user is a member (or can join).
    if (roomId && userId) {
      const chat = getChat(roomId);
      if (chat) {
        if (!chat.members.includes(userId)) {
          const r = joinChat(roomId, userId);
          if (r.error) {
            ws.send(JSON.stringify({ type: 'error', error: r.error }));
          }
        }
        if (chat.members.includes(userId)) {
          peer.roomId = roomId;
          if (!rooms.has(roomId)) rooms.set(roomId, new Set());
          rooms.get(roomId).add(id);
        }
      }
    }

    ws.send(
      JSON.stringify({
        type: 'welcome',
        id,
        name,
        userId,
        roomId: peer.roomId,
        users: peer.roomId ? roomPeerList(peer.roomId) : [],
      }),
    );
    if (peer.roomId) broadcastRoomPresence(peer.roomId);
    logger?.info?.({ id, userId, name, roomId: peer.roomId }, 'rt: peer joined');

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'rename': {
          peer.name = String(msg.name || '').slice(0, 40) || peer.name;
          if (peer.roomId) broadcastRoomPresence(peer.roomId);
          else broadcastPresence();
          break;
        }
        case 'camera': {
          peer.hasCamera = Boolean(msg.on);
          if (peer.roomId) broadcastRoomPresence(peer.roomId);
          else broadcastPresence();
          break;
        }
        case 'chat': {
          const text = String(msg.text || '').slice(0, 2000);
          if (peer.roomId) {
            // Persist chat text when coming from an authed user in a real room.
            if (peer.userId) {
              appendMessage(peer.roomId, {
                role: 'user',
                text,
                name: peer.name,
                userId: peer.userId,
              });
            }
            broadcastRoom(
              peer.roomId,
              { type: 'chat', from: peer.id, userId: peer.userId, name: peer.name, text },
              peer.id,
            );
          } else {
            broadcast({ type: 'chat', from: peer.id, name: peer.name, text }, peer.id);
          }
          break;
        }
        case 'speak': {
          const payload = {
            type: 'speak',
            from: peer.id,
            name: peer.name,
            text: String(msg.text || '').slice(0, 2000),
            mood: msg.mood || 'neutral',
            audio_base64: typeof msg.audio_base64 === 'string' ? msg.audio_base64 : '',
            content_type: msg.content_type || 'audio/mpeg',
          };
          if (peer.roomId) broadcastRoom(peer.roomId, payload, peer.id);
          else broadcast(payload, peer.id);
          break;
        }
        // WebRTC signaling relay (room-aware).
        case 'rtc-request':
        case 'rtc-offer':
        case 'rtc-answer':
        case 'rtc-ice':
        case 'rtc-close': {
          const toId = String(msg.to || '');
          if (!toId || !peers.has(toId)) return;
          // Don't allow cross-room signaling.
          const target = peers.get(toId);
          if (peer.roomId && target.roomId && peer.roomId !== target.roomId) return;
          sendTo(toId, { ...msg, from: peer.id, name: peer.name });
          break;
        }
        default:
          break;
      }
    });

    const cleanup = () => {
      if (peers.delete(id)) {
        if (peer.roomId) {
          const set = rooms.get(peer.roomId);
          if (set) {
            set.delete(id);
            if (set.size === 0) rooms.delete(peer.roomId);
            else broadcastRoomPresence(peer.roomId);
          }
          broadcastRoom(peer.roomId, { type: 'left', id, userId: peer.userId });
        } else {
          broadcastPresence();
          broadcast({ type: 'left', id });
        }
        logger?.info?.({ id, roomId: peer.roomId }, 'rt: peer left');
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // Heartbeat: close dead sockets so the peer list doesn't grow stale.
  setInterval(() => {
    for (const [id, p] of peers) {
      if (p.ws.readyState !== 1) { peers.delete(id); continue; }
      try { p.ws.ping(); } catch { peers.delete(id); }
    }
  }, 30_000).unref();
}

export function currentPeerCount() {
  return peers.size;
}
