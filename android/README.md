# Raven Android App

Native Java Android client for **Raven** — a shared AI group chat built on the
existing `ai-voice-middleware` (xAI Grok + ElevenLabs). Up to 4 people per
chat, Google Sign-In, persistent profile, shareable chat IDs, camera sharing
via WebRTC, and a dashboard of past chats similar in shape to Grok's.

## Highlights

- **Google SSO** via the modern Credential Manager API. The Google ID token is
  POSTed to `/raven/auth/google`; the server verifies the token against
  Google's JWKS, upserts the user, and returns a Raven session token.
- **Persistent profile** — user is stored server-side so preferences follow
  them across devices. The Raven session token is kept in
  `EncryptedSharedPreferences` on the device.
- **Shareable Raven Chat IDs** — each chat has an 8-char uppercase ID. You
  can share a deep link (`https://raven.app/c/<ID>` or `raven://chat?id=<ID>`)
  or paste an ID into the dashboard's **Join by ID** box.
- **Max 4 members**, enforced on the server.
- **Dashboard** (Grok-like): user header, New Chat button, Join-by-ID input,
  and a scrollable list of past chats with preview, member count, ID, and
  relative timestamp.
- **Chat screen**: Raven replies are requested via `/raven/chats/:id/ask`,
  which records the user turn and Raven's reply on the server. Peer chat
  lines are broadcast in real time over the existing `/rt` WebSocket, now
  scoped to rooms via `?room=<chatId>`.
- **Camera share box**: a grid of up to 4 video tiles — your own preview plus
  each peer — powered by a simple WebRTC mesh (`stream-webrtc-android`) using
  the existing signaling relay (`rtc-offer` / `rtc-answer` / `rtc-ice`).

## Build

```powershell
# From repo root
cd android

# Provide config (or put them in ~/.gradle/gradle.properties):
# RAVEN_BASE_URL: your deployed middleware host
# GOOGLE_WEB_CLIENT_ID: OAuth 2.0 Web client ID (from Google Cloud Console)
$env:ORG_GRADLE_PROJECT_RAVEN_BASE_URL = "https://your-host.up.railway.app"
$env:ORG_GRADLE_PROJECT_GOOGLE_WEB_CLIENT_ID = "xxxxx.apps.googleusercontent.com"

./gradlew :app:assembleDebug
```

> The Gradle wrapper JAR is not committed. Run `gradle wrapper` once (or
> open the `android/` folder in Android Studio, which will generate it).

## Configuring the server

Set these environment variables on the Node middleware:

```
GOOGLE_CLIENT_IDS=<comma-separated OAuth 2.0 Web client IDs>
# optional:
RAVEN_DATA_DIR=/var/lib/raven
```

The backend now exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/raven/auth/google` | Verify Google ID token, upsert user, return session token |
| POST | `/raven/auth/logout` | Revoke current session |
| GET  | `/raven/me` | Current profile |
| PATCH | `/raven/me/preferences` | Update preferences (voiceId, theme, mood, …) |
| GET  | `/raven/chats` | List your chats (dashboard) |
| POST | `/raven/chats` | Create a new Raven chat |
| GET  | `/raven/chats/:id` | Full chat detail + history |
| POST | `/raven/chats/:id/join` | Join a chat by ID (rejects if full) |
| POST | `/raven/chats/:id/leave` | Leave a chat |
| POST | `/raven/chats/:id/ask` | Send a user turn and receive Raven's reply |
| PATCH | `/raven/chats/:id` | Rename (owner only) |
| DELETE | `/raven/chats/:id` | Delete (owner only) |

The realtime WebSocket `/rt?raven=<session>&room=<chatId>&name=<name>` now
supports room scoping, so presence, chat broadcasts, and WebRTC signaling
stay within a single Raven chat.

## Folder layout

```
android/
  app/
    build.gradle
    src/main/
      AndroidManifest.xml
      java/com/raven/app/
        RavenApp.java
        data/AuthManager.java
        data/model/{ChatMessage,ChatSummary,RavenUser}.java
        net/{RavenApi,RealtimeSocket}.java
        rtc/WebRtcManager.java
        ui/{SignInActivity,DashboardActivity,ChatActivity}.java
        ui/adapter/{ChatListAdapter,MessageAdapter,VideoTileAdapter}.java
      res/layout/...
  build.gradle
  settings.gradle
```

## Notes

- In-memory session tokens on the server are invalidated on restart; clients
  re-authenticate silently via Google's `autoSelect`.
- Chat history + user profiles are persisted via a JSON file store at
  `RAVEN_DATA_DIR`. Swap `src/store.js` for Postgres/Redis for production.
- WebRTC uses a public STUN server. Add a TURN server for reliable
  connectivity behind symmetric NATs.
