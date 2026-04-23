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

/** @typedef {{ id:string, name:string, ws:import('ws').WebSocket, joinedAt:number, hasCamera:boolean }} Peer */

const peers = new Map(); // id -> Peer

function broadcast(obj, exceptId) {
  const json = JSON.stringify(obj);
  for (const [id, p] of peers) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) {
      try { p.ws.send(json); } catch {}
    }
  }
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
  // WebSocket can't send custom headers from the browser, so accept the key
  // as a query string. The same keys your API uses.
  if (config.apiKeys.length === 0) return true;
  try {
    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('key');
    return key && config.apiKeys.includes(key);
  } catch {
    return false;
  }
}

export function attachRealtime(server, logger) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/rt')) {
      socket.destroy();
      return;
    }
    if (!authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const id = crypto.randomBytes(6).toString('hex');
    let name = 'guest';
    try {
      const u = new URL(req.url, 'http://x');
      name = (u.searchParams.get('name') || '').slice(0, 40) || `guest-${id.slice(0, 4)}`;
    } catch {}
    const peer = { id, name, ws, joinedAt: Date.now(), hasCamera: false };
    peers.set(id, peer);

    ws.send(JSON.stringify({ type: 'welcome', id, name, count: peers.size, users: peerList() }));
    broadcastPresence();
    logger?.info?.({ id, name, count: peers.size }, 'rt: peer joined');

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'rename': {
          peer.name = String(msg.name || '').slice(0, 40) || peer.name;
          broadcastPresence();
          break;
        }
        case 'camera': {
          peer.hasCamera = Boolean(msg.on);
          broadcastPresence();
          break;
        }
        case 'chat': {
          // Broadcast a text chat line to everyone (moderator/room mode).
          broadcast({ type: 'chat', from: peer.id, name: peer.name, text: String(msg.text || '').slice(0, 2000) }, peer.id);
          break;
        }
        case 'speak': {
          // Rebroadcast one peer's TTS audio (base64) + text so other peers
          // play the same reply. Keep it small; Railway handles ~1 MB frames.
          broadcast({
            type: 'speak',
            from: peer.id,
            name: peer.name,
            text: String(msg.text || '').slice(0, 2000),
            mood: msg.mood || 'neutral',
            audio_base64: typeof msg.audio_base64 === 'string' ? msg.audio_base64 : '',
            content_type: msg.content_type || 'audio/mpeg',
          }, peer.id);
          break;
        }
        // WebRTC signaling relay.
        case 'rtc-request':
        case 'rtc-offer':
        case 'rtc-answer':
        case 'rtc-ice':
        case 'rtc-close': {
          const toId = String(msg.to || '');
          if (!toId || !peers.has(toId)) return;
          sendTo(toId, { ...msg, from: peer.id, name: peer.name });
          break;
        }
        default:
          // Ignore unknown messages.
          break;
      }
    });

    const cleanup = () => {
      if (peers.delete(id)) {
        broadcastPresence();
        broadcast({ type: 'left', id });
        logger?.info?.({ id, count: peers.size }, 'rt: peer left');
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
