import { config } from './config.js';

/**
 * Call xAI Grok chat completions (OpenAI-compatible API).
 * @param {object} opts
 * @param {string} [opts.prompt] - Convenience single-user prompt.
 * @param {Array<{role:string,content:string}>} [opts.messages] - Full message history.
 * @param {string} [opts.system] - Override system prompt.
 * @param {string} [opts.model]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{text:string, raw:any}>}
 */
export async function grokChat({
  prompt,
  messages,
  system,
  model,
  temperature = 0.7,
  maxTokens,
} = {}) {
  if (!config.xai.apiKey) {
    const err = new Error('XAI_API_KEY is not configured');
    err.status = 500;
    throw err;
  }

  const sys = system || config.xai.systemPrompt;
  const finalMessages = Array.isArray(messages) && messages.length > 0
    ? [{ role: 'system', content: sys }, ...messages.filter((m) => m.role !== 'system')]
    : [
        { role: 'system', content: sys },
        { role: 'user', content: String(prompt ?? '') },
      ];

  const body = {
    model: model || config.xai.model,
    messages: finalMessages,
    temperature,
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(`${config.xai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.xai.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`xAI Grok error ${res.status}: ${errText.slice(0, 500)}`);
    err.status = res.status === 401 ? 502 : 502;
    throw err;
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() || '';

  // Extract an optional leading mood tag. Accept several shapes Grok tends
  // to produce: "[mood: happy]", "[happy]", "(mood: happy)", "mood: happy\n".
  const allowed = /^(happy|excited|thinking|neutral|surprised|concerned|sad|playful|flirty|confident|angry|calm|curious)$/i;
  const patterns = [
    /^\s*[\[\(]\s*mood\s*[:\-]\s*([a-zA-Z_-]+)\s*[\]\)]\s*/i,
    /^\s*mood\s*[:\-]\s*([a-zA-Z_-]+)\s*[\r\n]+/i,
    /^\s*[\[\(]\s*([a-zA-Z_-]+)\s*[\]\)]\s*/,
  ];
  let mood = 'neutral';
  let text = raw;
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && allowed.test(m[1])) {
      mood = m[1].toLowerCase();
      text = raw.slice(m[0].length).trim();
      break;
    }
  }

  return { text, mood, raw: data };
}
