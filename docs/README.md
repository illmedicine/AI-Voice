# AI Companion Frontend

Static site that runs on GitHub Pages and talks to your Railway middleware.

## Deploy (from this `docs/` folder — simplest)

1. Push this repo to GitHub.
2. Repo **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: `main`, folder: `/docs`
3. Wait ~30s. Your site will be at
   `https://<your-user>.github.io/<repo-name>/`.

On first load it opens a settings dialog. Enter:

- **Middleware base URL** — your Railway HTTPS URL (e.g. `https://ai-voice-production-xxxx.up.railway.app`)
- **API key** — one of the values from `MIDDLEWARE_API_KEYS` on the middleware
- **Voice ID** — optional; defaults to whatever is set on the server
- **Companion name** — label shown in the header

Click **Test connection** first to verify `/health` returns OK, then **Save**.

## CORS

The middleware must allow your GitHub Pages origin. In Railway, set:

```
CORS_ORIGINS=https://<your-user>.github.io
```

(Or `*` while testing.) Redeploy after changing it.

## Swapping the avatar

Replace `docs/avatar.png` with any portrait. A square or 3:4 portrait aspect
with the face in the upper half works best. The `#avatarImg`
`object-position` rule in `styles.css` can be tweaked to re-center.

## Files

- `index.html` — page structure and settings dialog
- `styles.css` — visual design, mood styles, lip-sync mouth/blink
- `app.js` — chat, audio playback, lip-sync, waveform, history
- `avatar.png` — the companion's portrait
