# AI-Voice Middleware — xAI Grok → ElevenLabs

An always-online HTTP middleware that connects **xAI Grok** to **ElevenLabs TTS**
using a specific voice ID (e.g. `NQMJRVvPew6H...`). Send a prompt, get back
speech in your chosen voice.

## Endpoints

All endpoints except `/health` and `/` require the header:

```
x-api-key: <one of MIDDLEWARE_API_KEYS>
```

| Method | Path              | Purpose                                        |
|-------:|-------------------|------------------------------------------------|
| GET    | `/health`         | Liveness/readiness for uptime monitors         |
| POST   | `/v1/chat`        | Grok text reply only                           |
| POST   | `/v1/speak`       | ElevenLabs TTS only                            |
| POST   | `/v1/grok-speak`  | Grok → ElevenLabs, streams audio back          |

### Example — one-shot prompt to spoken audio

```bash
curl -X POST https://YOUR-HOST/v1/grok-speak \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Tell me a short joke about space."}' \
  --output reply.mp3
```

The audio streams back as `audio/mpeg`. Add `?return=json` to get
`{ text, audio_base64, content_type }` instead — handy for web chat UIs.

### Example — multi-turn chat

```bash
curl -X POST https://YOUR-HOST/v1/grok-speak \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "messages":[
          {"role":"user","content":"Hi, what are you?"},
          {"role":"assistant","content":"I am Grok."},
          {"role":"user","content":"Say that again with more enthusiasm."}
        ],
        "voiceId":"NQMJRVvPew6H..."
      }' \
  --output reply.mp3
```

## Local run

```bash
cp .env.example .env        # fill in your keys
npm install
npm start                   # or: npm run dev
```

Open http://localhost:8080/health — should return `{"ok":true,...}`.

## Always-online deployment

Pick whichever host you like — all three configs are included.

### Render (easiest free tier)

1. Push this repo to GitHub.
2. In Render, **New + → Blueprint** and point at the repo; it reads
   `render.yaml`.
3. After the service is created, set the secrets in the dashboard:
   `XAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
   `MIDDLEWARE_API_KEYS`, and (optionally) `SELF_PING_URL` = your
   public `https://<service>.onrender.com/health` URL to prevent sleep.

### Fly.io

```bash
fly launch --no-deploy                   # creates the app
fly secrets set \
  XAI_API_KEY=... \
  ELEVENLABS_API_KEY=... \
  ELEVENLABS_VOICE_ID=NQMJRVvPew6H... \
  MIDDLEWARE_API_KEYS=$(openssl rand -hex 24)
fly deploy
```

`fly.toml` is configured with `min_machines_running = 1` so it stays
warm 24/7.

### Railway (recommended — no Docker needed)

Railway builds directly from source with Nixpacks; `railway.json` + `Procfile`
are already configured.

1. **New Project → Deploy from GitHub repo** (or `railway up` from the CLI in
   an existing project).
2. In the service's **Variables** tab, add:
   - `XAI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID` (e.g. `NQMJRVvPew6H...`)
   - `MIDDLEWARE_API_KEYS` — a long random string (or a few, comma-separated)
   - `GROK_MODEL` = `grok-2-latest` (optional)
   - `ELEVENLABS_MODEL_ID` = `eleven_multilingual_v2` (optional)
   - `CORS_ORIGINS` = your frontend origin, or `*` for testing
3. Under **Settings → Networking**, click **Generate Domain** to get a public
   HTTPS URL. Railway sets `PORT` automatically — the server respects it.
4. Health check path is already set to `/health`.
5. (Optional, for absolutely-never-sleeps behavior) set
   `SELF_PING_URL=https://<your-domain>/health` so the app pings itself every
   5 minutes. On Railway's paid plan this isn't needed; the service stays up.

### Docker anywhere

```bash
docker build -t ai-voice-middleware .
docker run -d --restart=always -p 8080:8080 --env-file .env \
  --name ai-voice ai-voice-middleware
```

## Security checklist before going public

- Set **long random** values for `MIDDLEWARE_API_KEYS`. Without them the
  service runs open (a warning is logged at boot).
- Restrict `CORS_ORIGINS` to your actual frontend origins.
- Monitor your xAI and ElevenLabs usage dashboards — every request costs
  tokens and characters.
- Consider tightening `RATE_LIMIT_PER_MIN` if you expose the service to
  end users directly rather than through your own app.

## Environment variables

See `.env.example` for the full list with defaults.
