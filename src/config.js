import 'dotenv/config';

function parseList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFloatOrUndef(v) {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKeys: parseList(process.env.MIDDLEWARE_API_KEYS),
  corsOrigins: parseList(process.env.CORS_ORIGINS),

  xai: {
    apiKey: process.env.XAI_API_KEY || '',
    baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    model: process.env.GROK_MODEL || 'grok-4-fast-non-reasoning',
    systemPrompt:
      process.env.GROK_SYSTEM_PROMPT ||
      'You are a warm, conversational companion speaking out loud through text-to-speech. Keep replies natural and fairly short (1–4 sentences) unless asked for more. Begin every reply with a mood tag on its own, formatted exactly as "[mood: X]" where X is one of: happy, excited, thinking, neutral, surprised, concerned, sad, playful, flirty, confident. Then continue with the spoken reply. Do not use asterisks, emoji, stage directions, or markdown. Speak in plain sentences.',
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || '',
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
    voiceSettings: {
      stability: parseFloatOrUndef(process.env.ELEVENLABS_STABILITY),
      similarity_boost: parseFloatOrUndef(process.env.ELEVENLABS_SIMILARITY_BOOST),
      style: parseFloatOrUndef(process.env.ELEVENLABS_STYLE),
      use_speaker_boost:
        process.env.ELEVENLABS_USE_SPEAKER_BOOST === undefined
          ? undefined
          : process.env.ELEVENLABS_USE_SPEAKER_BOOST === 'true',
    },
  },

  selfPing: {
    url: process.env.SELF_PING_URL || '',
    intervalMs: Number(process.env.SELF_PING_INTERVAL_MS || 300000),
  },
};

export function assertConfig() {
  const missing = [];
  if (!config.xai.apiKey) missing.push('XAI_API_KEY');
  if (!config.elevenlabs.apiKey) missing.push('ELEVENLABS_API_KEY');
  if (!config.elevenlabs.voiceId) missing.push('ELEVENLABS_VOICE_ID');
  if (missing.length) {
    // Don't crash — just warn. The /health endpoint should still work so
    // the host considers the service "up" while you finish configuring.
    // eslint-disable-next-line no-console
    console.warn(
      `[config] Missing env vars: ${missing.join(', ')}. Routes requiring them will return 500.`,
    );
  }
  if (config.apiKeys.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] MIDDLEWARE_API_KEYS is empty. The service is OPEN to the internet. Set keys before going public.',
    );
  }
}
