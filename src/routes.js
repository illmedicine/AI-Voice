import { Router } from 'express';
import { Readable } from 'node:stream';
import { requireApiKey } from './auth.js';
import { grokChat } from './grok.js';
import { elevenlabsTTS, contentTypeForFormat } from './elevenlabs.js';
import { config } from './config.js';

export const router = Router();

// Public health check — no auth, used by uptime monitors and the self-ping loop.
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'ai-voice-middleware',
    uptime: process.uptime(),
    env: config.nodeEnv,
    configured: {
      xai: Boolean(config.xai.apiKey),
      elevenlabs: Boolean(config.elevenlabs.apiKey && config.elevenlabs.voiceId),
      auth: config.apiKeys.length > 0,
    },
  });
});

// Also allow the limiter skip to match the API summary path.
router.get('/api/', (req, res) => res.redirect(301, '/api'));
router.get('/api', (req, res) => {
  res.type('text/plain').send(
    [
      'AI-Voice middleware — xAI Grok -> ElevenLabs',
      '',
      'Endpoints (send header: x-api-key: <your key>):',
      '  GET  /health                  liveness/readiness',
      '  POST /v1/chat                 Grok text reply   { prompt | messages }',
      '  POST /v1/speak                ElevenLabs TTS    { text, voiceId? }',
      '  POST /v1/grok-speak           Grok -> TTS audio { prompt | messages }',
    ].join('\n'),
  );
});

// Helper: stream a fetch Response body out to an Express response.
async function pipeFetchBody(fetchRes, expressRes) {
  const nodeStream = Readable.fromWeb(fetchRes.body);
  nodeStream.on('error', (e) => {
    if (!expressRes.headersSent) {
      expressRes.status(502).json({ error: 'Upstream stream error', detail: String(e?.message || e) });
    } else {
      expressRes.end();
    }
  });
  nodeStream.pipe(expressRes);
}

// --- Grok text chat ---
router.post('/v1/chat', requireApiKey, async (req, res) => {
  try {
    const { prompt, messages, system, model, temperature, max_tokens } = req.body || {};
    if (!prompt && !(Array.isArray(messages) && messages.length)) {
      return res.status(400).json({ error: 'Provide `prompt` or `messages`.' });
    }
    const { text, mood, raw } = await grokChat({
      prompt,
      messages,
      system,
      model,
      temperature,
      maxTokens: max_tokens,
    });
    res.json({ text, mood, model: raw?.model, usage: raw?.usage });
  } catch (err) {
    req.log?.error({ err }, 'grok chat failed');
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- ElevenLabs TTS only ---
router.post('/v1/speak', requireApiKey, async (req, res) => {
  try {
    const { text, voiceId, modelId, outputFormat, voiceSettings } = req.body || {};
    const upstream = await elevenlabsTTS({
      text,
      voiceId,
      modelId,
      outputFormat,
      voiceSettings,
    });
    const fmt = outputFormat || config.elevenlabs.outputFormat;
    res.setHeader('Content-Type', contentTypeForFormat(fmt));
    res.setHeader('Cache-Control', 'no-store');
    await pipeFetchBody(upstream, res);
  } catch (err) {
    req.log?.error({ err }, 'elevenlabs tts failed');
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Grok -> ElevenLabs end-to-end ---
// Returns audio/mpeg by default. Add ?return=json to instead get
// { text, audio_base64 } useful for some chat UIs.
router.post('/v1/grok-speak', requireApiKey, async (req, res) => {
  try {
    const {
      prompt,
      messages,
      system,
      model,
      temperature,
      max_tokens,
      voiceId,
      modelId,
      outputFormat,
      voiceSettings,
    } = req.body || {};

    if (!prompt && !(Array.isArray(messages) && messages.length)) {
      return res.status(400).json({ error: 'Provide `prompt` or `messages`.' });
    }

    const { text, mood } = await grokChat({
      prompt,
      messages,
      system,
      model,
      temperature,
      maxTokens: max_tokens,
    });

    if (!text) {
      return res.status(502).json({ error: 'Grok returned empty response.' });
    }

    const upstream = await elevenlabsTTS({
      text,
      voiceId,
      modelId,
      outputFormat,
      voiceSettings,
    });

    const fmt = outputFormat || config.elevenlabs.outputFormat;

    if (req.query.return === 'json') {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.json({
        text,
        mood,
        content_type: contentTypeForFormat(fmt),
        audio_base64: buf.toString('base64'),
      });
    }

    res.setHeader('Content-Type', contentTypeForFormat(fmt));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Grok-Text', encodeURIComponent(text.slice(0, 1000)));
    res.setHeader('X-Grok-Mood', mood || 'neutral');
    res.setHeader('Access-Control-Expose-Headers', 'X-Grok-Text, X-Grok-Mood');
    await pipeFetchBody(upstream, res);
  } catch (err) {
    req.log?.error({ err }, 'grok-speak failed');
    res.status(err.status || 500).json({ error: err.message });
  }
});
