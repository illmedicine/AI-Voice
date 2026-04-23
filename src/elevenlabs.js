import { config } from './config.js';

function cleanVoiceSettings(vs) {
  const out = {};
  for (const [k, v] of Object.entries(vs || {})) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Call ElevenLabs text-to-speech and return a streaming Response.
 * The caller is responsible for piping `response.body` to the client.
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} [opts.voiceId]
 * @param {string} [opts.modelId]
 * @param {string} [opts.outputFormat] e.g. mp3_44100_128, pcm_16000
 * @param {object} [opts.voiceSettings]
 * @returns {Promise<Response>}
 */
export async function elevenlabsTTS({
  text,
  voiceId,
  modelId,
  outputFormat,
  voiceSettings,
} = {}) {
  if (!config.elevenlabs.apiKey) {
    const err = new Error('ELEVENLABS_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  const vId = voiceId || config.elevenlabs.voiceId;
  if (!vId) {
    const err = new Error('ELEVENLABS_VOICE_ID is not configured');
    err.status = 500;
    throw err;
  }
  if (!text || !String(text).trim()) {
    const err = new Error('text is required');
    err.status = 400;
    throw err;
  }

  const fmt = outputFormat || config.elevenlabs.outputFormat;
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vId)}/stream` +
    `?output_format=${encodeURIComponent(fmt)}`;

  const body = {
    text: String(text),
    model_id: modelId || config.elevenlabs.modelId,
  };
  const vs = cleanVoiceSettings(voiceSettings || config.elevenlabs.voiceSettings);
  if (vs) body.voice_settings = vs;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenlabs.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs error ${res.status}: ${errText.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }

  return res;
}

export function contentTypeForFormat(format) {
  if (!format) return 'audio/mpeg';
  if (format.startsWith('mp3')) return 'audio/mpeg';
  if (format.startsWith('pcm')) return 'audio/wave';
  if (format.startsWith('ulaw')) return 'audio/basic';
  if (format.startsWith('opus')) return 'audio/ogg';
  return 'application/octet-stream';
}

/** List available ElevenLabs models. */
export async function listModels() {
  if (!config.elevenlabs.apiKey) {
    const err = new Error('ELEVENLABS_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  const res = await fetch('https://api.elevenlabs.io/v1/models', {
    headers: { 'xi-api-key': config.elevenlabs.apiKey },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs models error ${res.status}: ${errText.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

/** List voices available on the configured ElevenLabs account. */
export async function listVoices() {
  if (!config.elevenlabs.apiKey) {
    const err = new Error('ELEVENLABS_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': config.elevenlabs.apiKey },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs voices error ${res.status}: ${errText.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

/**
 * TTS with alignment — returns JSON containing base64 audio and per-character
 * timing, which we use for accurate lip-sync.
 */
export async function elevenlabsTTSWithTimestamps({
  text,
  voiceId,
  modelId,
  outputFormat,
  voiceSettings,
} = {}) {
  if (!config.elevenlabs.apiKey) {
    const err = new Error('ELEVENLABS_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  const vId = voiceId || config.elevenlabs.voiceId;
  if (!vId) {
    const err = new Error('ELEVENLABS_VOICE_ID is not configured');
    err.status = 500;
    throw err;
  }
  if (!text || !String(text).trim()) {
    const err = new Error('text is required');
    err.status = 400;
    throw err;
  }

  const fmt = outputFormat || config.elevenlabs.outputFormat;
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vId)}/with-timestamps` +
    `?output_format=${encodeURIComponent(fmt)}`;

  const body = {
    text: String(text),
    model_id: modelId || config.elevenlabs.modelId,
  };
  const vs = cleanVoiceSettings(voiceSettings || config.elevenlabs.voiceSettings);
  if (vs) body.voice_settings = vs;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenlabs.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs error ${res.status}: ${errText.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }

  const json = await res.json();
  // ElevenLabs returns: { audio_base64, alignment: { characters, character_start_times_seconds, character_end_times_seconds }, normalized_alignment? }
  return { ...json, content_type: contentTypeForFormat(fmt) };
}
