// AI Companion frontend for GitHub Pages.
// Talks to the Railway middleware (Grok -> ElevenLabs).

const LS = {
  endpoint: 'aivoice.endpoint',
  apiKey:   'aivoice.apiKey',
  voiceId:  'aivoice.voiceId',
  modelId:  'aivoice.modelId',
  useTimed: 'aivoice.useTimed',
  name:     'aivoice.name',
  history:  'aivoice.history',
  muted:    'aivoice.muted',
  mouth:    'aivoice.mouth', // {x,y,w,h} in %
  wake:     'aivoice.wake',
  sleep:    'aivoice.sleep',
  stopWord: 'aivoice.stopWord',
  autoListen: 'aivoice.autoListen',
};

const $ = (id) => document.getElementById(id);

// ---------- Defaults (baked-in so phones "just work") ----------
// This frontend is paired with a specific Railway deployment. The API key
// below only gates that one instance; rotate it on Railway any time and
// update here to invalidate all old clients.
const DEFAULTS = {
  endpoint: 'https://ai-voice-production-9c61.up.railway.app',
  apiKey:   'pNjHcXii3yC7DlFfah4GB_L5wwb-8qOcNKvmqi6bdFFULhxjxJ0dJ8HQY7FEahvn',
  voiceId:  'NQMJRVvPew6HsaebYnZj',
  modelId:  'eleven_flash_v2_5',
};

// Heal bad saved values (placeholders, example URLs, empty strings) by
// reverting them to DEFAULTS. Runs every boot so old clients self-repair.
(function healSavedConfig() {
  const ep = (localStorage.getItem(LS.endpoint) || '').trim();
  const badEp = !ep
    || /your-service\.up\.railway\.app/i.test(ep)
    || /example\.com/i.test(ep)
    || /localhost|127\.0\.0\.1/i.test(ep)
    || !/^https?:\/\//i.test(ep);
  if (badEp) localStorage.setItem(LS.endpoint, DEFAULTS.endpoint);

  const key = (localStorage.getItem(LS.apiKey) || '').trim();
  if (!key || key === 'your-key' || key.length < 16) {
    localStorage.setItem(LS.apiKey, DEFAULTS.apiKey);
  }

  const vid = (localStorage.getItem(LS.voiceId) || '').trim();
  if (!vid) localStorage.setItem(LS.voiceId, DEFAULTS.voiceId);

  const mid = (localStorage.getItem(LS.modelId) || '').trim();
  if (!mid) localStorage.setItem(LS.modelId, DEFAULTS.modelId);
})();

// ---------- State ----------
const state = {
  endpoint: localStorage.getItem(LS.endpoint) || DEFAULTS.endpoint,
  apiKey:   localStorage.getItem(LS.apiKey)   || DEFAULTS.apiKey,
  voiceId:  localStorage.getItem(LS.voiceId)  || DEFAULTS.voiceId,
  modelId:  localStorage.getItem(LS.modelId)  || DEFAULTS.modelId,
  useTimed: localStorage.getItem(LS.useTimed) !== '0',
  name:     localStorage.getItem(LS.name)     || 'Companion',
  muted:    localStorage.getItem(LS.muted) === '1',
  history:  JSON.parse(localStorage.getItem(LS.history) || '[]'),
  mouth:    JSON.parse(localStorage.getItem(LS.mouth) || 'null') ||
            { x: 50, y: 72, w: 12, h: 5 }, // sensible default for a centered portrait
  busy: false,
  audioCtx: null,
  analyser: null,
  currentAudio: null,
  mood: 'neutral',
  calibrating: false,

  // Voice input / wake word state
  recognizer: null,
  listening: false,          // user wants mic on (persists across pauses)
  recognizerRunning: false,  // whether the recognizer is currently active
  pausedForPlayback: false,  // true while we've muted the mic for her voice
  listenMode: 'off',         // 'off' | 'awake' | 'asleep' | 'speaking'
  wakePhrase:  (localStorage.getItem(LS.wake)  || 'wake up jayla').toLowerCase(),
  sleepPhrase: (localStorage.getItem(LS.sleep) || 'jayla sleep time').toLowerCase(),
  stopPhrase:  (localStorage.getItem(LS.stopWord) || 'jayla stop').toLowerCase(),
  autoListen:  localStorage.getItem(LS.autoListen) === '1',
  pendingTranscript: '',
  silenceTimer: 0,
};

// ---------- DOM ----------
const els = {
  dialog:       $('settings'),
  cfgEndpoint:  $('cfgEndpoint'),
  cfgApiKey:    $('cfgApiKey'),
  cfgVoice:     $('cfgVoice'),
  cfgVoiceSelect: $('cfgVoiceSelect'),
  cfgModelSelect: $('cfgModelSelect'),
  cfgUseTimed:  $('cfgUseTimed'),
  cfgName:      $('cfgName'),
  cfgWake:      $('cfgWake'),
  cfgSleep:     $('cfgSleep'),
  cfgStop:      $('cfgStop'),
  cfgAutoListen:$('cfgAutoListen'),
  testBtn:      $('testBtn'),
  testResult:   $('testResult'),
  shareBtn:     $('shareBtn'),
  settingsForm: $('settingsForm'),

  settingsBtn:  $('settingsBtn'),
  muteBtn:      $('muteBtn'),
  micBtn:       $('micBtn'),
  clearBtn:     $('clearBtn'),
  sendBtn:      $('sendBtn'),
  input:        $('input'),
  composer:     $('composer'),
  messages:     $('messages'),
  headerTitle:  $('headerTitle'),
  connDot:      $('connDot'),
  stateText:    $('stateText'),
  subStateText: $('subStateText'),

  portrait:     $('portrait'),
  blink:        $('blink'),
  mouth:        $('mouth'),
  waveform:     $('waveform'),
  avatarJaw:    $('avatarJaw'),
  calibMarker:  $('calibMarker'),
  calibHint:    $('calibHint'),
  calibBtn:     $('calibBtn'),
  calibCancelBtn: $('calibCancelBtn'),
  listenChip:   $('listenChip'),
  listenChipText: $('listenChipText'),
  listenHeard:  $('listenHeard'),
};

// ---------- Boot ----------
function boot() {
  applyName();
  els.muteBtn.textContent = state.muted ? '🔇' : '🔊';
  els.muteBtn.setAttribute('aria-pressed', String(state.muted));

  // Restore history
  for (const m of state.history) renderMessage(m, { animate: false });

  // Events
  els.settingsBtn.onclick = openSettings;
  els.clearBtn.onclick = clearChat;
  els.muteBtn.onclick = toggleMute;
  els.micBtn.onclick = toggleListening;
  els.composer.addEventListener('submit', onSend);
  els.input.addEventListener('keydown', onInputKey);
  els.input.addEventListener('input', autoGrow);
  els.testBtn.addEventListener('click', testConnection);
  els.shareBtn.addEventListener('click', copyPhoneSetupLink);
  els.settingsForm.addEventListener('submit', saveSettings);
  els.calibBtn.addEventListener('click', startCalibration);
  els.calibCancelBtn.addEventListener('click', cancelCalibration);
  els.portrait.addEventListener('click', onPortraitClick);

  applyMouthCalibration();

  // Blink loop
  setInterval(() => {
    if (Math.random() < 0.5) {
      els.blink.classList.remove('blink');
      // reflow to restart animation
      void els.blink.offsetWidth;
      els.blink.classList.add('blink');
    }
  }, 3800);

  updateConnectionIndicator();
  setStage(state.endpoint && state.apiKey ? 'ACTIVE' : 'INITIALIZING',
           state.endpoint && state.apiKey ? 'Waiting for prompt' : 'Tap settings to begin');

  // Warm up the middleware so the first real request is snappy (Railway can
  // be slow on cold start; mobile is especially sensitive).
  if (state.endpoint) {
    fetch(state.endpoint + '/health', { cache: 'no-store' }).catch(() => {});
  }

  // Consume ?setup= / #setup= from the URL for easy phone provisioning.
  consumeSetupHash();

  if (!state.endpoint || !state.apiKey) openSettings();

  // If the user asked to always-listen on load and we have creds, hint them to
  // click the mic. Browsers require a user gesture for the first mic permission,
  // so auto-starting silently would just fail.
  if (state.autoListen && state.endpoint && state.apiKey) {
    setStage('ACTIVE', 'Tap \ud83c\udf99 to start always-listening');
    els.micBtn.classList.add('hint');
  }
}

function applyName() {
  const n = state.name || 'Companion';
  els.headerTitle.textContent = n;
  document.title = n;
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
}

function onInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
}

// ---------- Settings ----------
function openSettings() {
  els.cfgEndpoint.value = state.endpoint;
  els.cfgApiKey.value = state.apiKey;
  els.cfgVoice.value = state.voiceId;
  els.cfgName.value = state.name;
  els.cfgUseTimed.checked = state.useTimed;
  els.cfgWake.value  = state.wakePhrase;
  els.cfgSleep.value = state.sleepPhrase;
  els.cfgStop.value  = state.stopPhrase;
  els.cfgAutoListen.checked = state.autoListen;
  els.testResult.textContent = '';
  els.dialog.showModal();
  if (state.endpoint && state.apiKey) {
    populateVoicesAndModels();
  }
}

async function populateVoicesAndModels() {
  // Voices
  try {
    const r = await fetch(state.endpoint + '/v1/voices', {
      headers: { 'x-api-key': state.apiKey },
    });
    if (r.ok) {
      const { voices } = await r.json();
      const sel = els.cfgVoiceSelect;
      sel.innerHTML = '<option value="">(server default)</option>';
      for (const v of voices) {
        const o = document.createElement('option');
        o.value = v.voice_id;
        const labels = v.labels ? Object.values(v.labels).slice(0, 3).join(', ') : '';
        o.textContent = `${v.name}${labels ? ' — ' + labels : ''}`;
        if (v.voice_id === state.voiceId) o.selected = true;
        sel.appendChild(o);
      }
    }
  } catch {}
  // Models
  try {
    const r = await fetch(state.endpoint + '/v1/models', {
      headers: { 'x-api-key': state.apiKey },
    });
    if (r.ok) {
      const { models } = await r.json();
      const sel = els.cfgModelSelect;
      sel.innerHTML = '<option value="">(server default)</option>';
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m.model_id;
        o.textContent = `${m.name || m.model_id}`;
        if (m.model_id === state.modelId) o.selected = true;
        sel.appendChild(o);
      }
    }
  } catch {}
}

function saveSettings(e) {
  state.endpoint = els.cfgEndpoint.value.trim().replace(/\/+$/, '');
  state.apiKey   = els.cfgApiKey.value.trim();
  state.voiceId  = (els.cfgVoiceSelect.value || els.cfgVoice.value).trim();
  state.modelId  = els.cfgModelSelect.value.trim();
  state.useTimed = els.cfgUseTimed.checked;
  state.name     = els.cfgName.value.trim() || 'Companion';
  state.wakePhrase  = (els.cfgWake.value.trim()  || 'wake up jayla').toLowerCase();
  state.sleepPhrase = (els.cfgSleep.value.trim() || 'jayla sleep time').toLowerCase();
  state.stopPhrase  = (els.cfgStop.value.trim()  || 'jayla stop').toLowerCase();
  state.autoListen  = els.cfgAutoListen.checked;
  localStorage.setItem(LS.endpoint, state.endpoint);
  localStorage.setItem(LS.apiKey, state.apiKey);
  localStorage.setItem(LS.voiceId, state.voiceId);
  localStorage.setItem(LS.modelId, state.modelId);
  localStorage.setItem(LS.useTimed, state.useTimed ? '1' : '0');
  localStorage.setItem(LS.name, state.name);
  localStorage.setItem(LS.wake, state.wakePhrase);
  localStorage.setItem(LS.sleep, state.sleepPhrase);
  localStorage.setItem(LS.stopWord, state.stopPhrase);
  localStorage.setItem(LS.autoListen, state.autoListen ? '1' : '0');
  applyName();
  updateConnectionIndicator();
  setStage('ACTIVE', 'Waiting for prompt');
}

async function testConnection() {
  const ep = els.cfgEndpoint.value.trim().replace(/\/+$/, '');
  if (!ep) { els.testResult.textContent = 'Enter a URL first.'; return; }
  if (!/^https?:\/\//i.test(ep)) {
    els.testResult.textContent = 'URL must start with https:// (or http:// for local).';
    return;
  }
  if (location.protocol === 'https:' && ep.startsWith('http://')) {
    els.testResult.textContent = 'Mixed content: this page is HTTPS so the middleware URL must be https:// too.';
    return;
  }
  els.testResult.textContent = 'Pinging ' + ep + '/health …';
  try {
    const r = await fetch(ep + '/health', { mode: 'cors' });
    const j = await r.json();
    if (r.ok && j.ok) {
      els.testResult.textContent =
        `OK — xai:${j.configured.xai ? '✓' : '✗'} elevenlabs:${j.configured.elevenlabs ? '✓' : '✗'} auth:${j.configured.auth ? '✓' : '✗'}`;
    } else {
      els.testResult.textContent = 'Reachable but unhealthy: ' + JSON.stringify(j);
    }
  } catch (e) {
    els.testResult.textContent =
      'Failed: ' + (e.message || e) +
      '  — check that the URL is exactly your Railway https URL and that the phone has internet.';
  }
}

function updateConnectionIndicator() {
  const ok = Boolean(state.endpoint && state.apiKey);
  els.connDot.classList.toggle('ok', ok);
  els.connDot.title = ok ? 'Configured' : 'Not configured';
}

// ---------- Phone setup helper ----------
// Encode current endpoint + key into a share link: <page>#setup=<base64-json>.
// Open that link on your phone once and settings auto-populate.
function copyPhoneSetupLink() {
  const ep  = els.cfgEndpoint.value.trim().replace(/\/+$/, '');
  const key = els.cfgApiKey.value.trim();
  if (!ep || !key) {
    els.testResult.textContent = 'Fill URL + API key first, then tap again.';
    return;
  }
  const payload = { ep, key, v: (els.cfgVoiceSelect.value || '').trim(), m: (els.cfgModelSelect.value || '').trim() };
  const token = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const link = location.origin + location.pathname + '#setup=' + token;
  const done = (msg) => { els.testResult.textContent = msg; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(
      () => done('Copied! Open this link on your phone.'),
      () => { window.prompt('Copy this link for your phone:', link); done('Link ready.'); }
    );
  } else {
    window.prompt('Copy this link for your phone:', link);
    done('Link ready.');
  }
}

function consumeSetupHash() {
  const hash = location.hash.replace(/^#/, '');
  const query = location.search.replace(/^\?/, '');
  const parts = (hash + '&' + query).split('&').filter(Boolean);
  let token = '';
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 'setup' && v) { token = v; break; }
  }
  if (!token) return;
  try {
    const json = decodeURIComponent(escape(atob(
      token.replace(/-/g, '+').replace(/_/g, '/')
    )));
    const data = JSON.parse(json);
    if (data.ep)  { state.endpoint = data.ep; localStorage.setItem(LS.endpoint, data.ep); }
    if (data.key) { state.apiKey   = data.key; localStorage.setItem(LS.apiKey, data.key); }
    if (data.v)   { state.voiceId  = data.v;  localStorage.setItem(LS.voiceId, data.v); }
    if (data.m)   { state.modelId  = data.m;  localStorage.setItem(LS.modelId, data.m); }
    // Scrub so the creds don't linger in history.
    history.replaceState(null, '', location.origin + location.pathname);
    updateConnectionIndicator();
    setStage('ACTIVE', 'Phone setup loaded — ready');
  } catch (e) {
    console.warn('Bad setup token:', e);
  }
}

// ---------- Mouth calibration ----------
function applyMouthCalibration() {
  const { x, y, w, h } = state.mouth;
  // Position the animated mouth overlay.
  els.mouth.style.left = x + '%';
  els.mouth.style.top  = y + '%';
  els.mouth.style.width  = w + '%';
  els.mouth.style.height = h + '%';
  // Position the jaw clip so only the lower face moves.
  // Clip top ≈ a bit above the mouth, extending to bottom of portrait.
  const clipTop = Math.max(0, Math.min(95, y - h * 0.8));
  els.avatarJaw.style.setProperty('--mouth-y', clipTop + '%');
  els.avatarJaw.style.setProperty('--mouth-h', (100 - clipTop) + '%');
  // Calibration marker mirror
  els.calibMarker.style.left = x + '%';
  els.calibMarker.style.top  = y + '%';
  els.calibMarker.style.width  = w + '%';
  els.calibMarker.style.height = h + '%';
}

function startCalibration() {
  els.dialog.close();
  state.calibrating = true;
  els.portrait.classList.add('calibrating');
  els.calibHint.hidden = false;
  setStage('CALIBRATING', 'Click on her mouth');
}

function cancelCalibration() {
  state.calibrating = false;
  els.portrait.classList.remove('calibrating');
  els.calibHint.hidden = true;
  setStage('ACTIVE', 'Waiting for prompt');
  openSettings();
}

function onPortraitClick(e) {
  if (!state.calibrating) return;
  const rect = els.portrait.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  // Keep whatever size was set last (default 12x5). User can re-size in settings later.
  state.mouth = {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    w: state.mouth.w || 12,
    h: state.mouth.h || 5,
  };
  localStorage.setItem(LS.mouth, JSON.stringify(state.mouth));
  applyMouthCalibration();
  state.calibrating = false;
  els.portrait.classList.remove('calibrating');
  els.calibHint.hidden = true;
  // Play a short demo wiggle so user sees the result immediately.
  demoMouth();
  setStage('ACTIVE', 'Mouth calibrated');
  openSettings();
}

function demoMouth() {
  let t = 0;
  const id = setInterval(() => {
    t += 1;
    const v = Math.abs(Math.sin(t / 2)) * (t < 12 ? 1 : 0);
    els.mouth.style.setProperty('--mouth', v.toFixed(3));
    els.avatarJaw.style.setProperty('--mouth', v.toFixed(3));
    if (t > 16) {
      clearInterval(id);
      els.mouth.style.setProperty('--mouth', '0');
      els.avatarJaw.style.setProperty('--mouth', '0');
    }
  }, 80);
}

// ---------- Chat ----------
function renderMessage(m, opts = { animate: true }) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  if (m.role === 'bot' && m.mood) {
    const mood = document.createElement('span');
    mood.className = 'mood';
    mood.textContent = m.mood;
    el.appendChild(mood);
  }
  el.appendChild(document.createTextNode(m.text));
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return el;
}

function saveHistory() {
  // Cap to last 40 messages to keep context bounded.
  const trimmed = state.history.slice(-40);
  localStorage.setItem(LS.history, JSON.stringify(trimmed));
}

function clearChat() {
  if (!confirm('Clear conversation?')) return;
  state.history = [];
  saveHistory();
  els.messages.innerHTML = '';
}

function toggleMute() {
  state.muted = !state.muted;
  localStorage.setItem(LS.muted, state.muted ? '1' : '0');
  els.muteBtn.textContent = state.muted ? '🔇' : '🔊';
  els.muteBtn.setAttribute('aria-pressed', String(state.muted));
  if (state.muted && state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
    stopLipSync();
  }
}

async function onSend(e) {
  e.preventDefault();
  if (state.busy) return;
  if (!state.endpoint || !state.apiKey) { openSettings(); return; }

  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = ''; autoGrow();

  const userMsg = { role: 'user', text };
  state.history.push(userMsg);
  renderMessage(userMsg);
  saveHistory();

  state.busy = true;
  els.sendBtn.disabled = true;
  els.connDot.classList.remove('ok'); els.connDot.classList.add('busy');
  setStage('THINKING', 'Generating response…');
  setMood('thinking');

  // Typing placeholder
  const typingEl = document.createElement('div');
  typingEl.className = 'msg bot typing';
  typingEl.textContent = ' ';
  els.messages.appendChild(typingEl);
  els.messages.scrollTop = els.messages.scrollHeight;

  try {
    const path = state.muted
      ? '/v1/chat'
      : (state.useTimed ? '/v1/grok-speak-timed' : '/v1/grok-speak?return=json');
    const url = state.endpoint + path;

    const messages = toMessageArray(state.history);
    const body = { messages };
    if (state.voiceId) body.voiceId = state.voiceId;
    if (state.modelId) body.modelId = state.modelId;

    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await extractErr(r));
    const j = await r.json();

    typingEl.remove();

    const mood = (j.mood || 'neutral').toLowerCase();
    const replyText = j.text || '';
    setMood(mood);

    const botMsg = { role: 'bot', text: replyText, mood };
    state.history.push(botMsg);
    renderMessage(botMsg);
    saveHistory();

    if (!state.muted && j.audio_base64) {
      setStage('SPEAKING', 'Now playing voice');
      // playAudio handles pausing/resuming the mic + chip state.
      await playAudio(j.audio_base64, j.content_type || 'audio/mpeg', j.alignment);
    }
    setStage('ACTIVE', 'Waiting for prompt');
  } catch (err) {
    typingEl.remove();
    setStage('ERROR', 'Check settings or middleware');
    setMood('concerned');
    const e = { role: 'err', text: err.message || String(err) };
    renderMessage(e);
  } finally {
    state.busy = false;
    els.sendBtn.disabled = false;
    els.connDot.classList.remove('busy');
    updateConnectionIndicator();
  }
}

function toMessageArray(history) {
  return history
    .filter((m) => m.role === 'user' || m.role === 'bot')
    .map((m) => ({
      role: m.role === 'bot' ? 'assistant' : 'user',
      content: m.text,
    }));
}

async function extractErr(res) {
  try { const j = await res.json(); return j.error || JSON.stringify(j); }
  catch { return (await res.text().catch(() => '')) || `HTTP ${res.status}`; }
}

// Turn a cryptic "Failed to fetch" into actionable guidance.
function describeFetchError(err, url) {
  const base = (err && err.message) ? err.message : String(err);
  const hints = [];
  if (!state.endpoint) {
    hints.push('No middleware URL set — open Settings and paste your Railway https URL.');
  }
  if (!state.apiKey) {
    hints.push('No API key set — open Settings and paste your middleware API key.');
  }
  try {
    const u = new URL(url);
    if (location.protocol === 'https:' && u.protocol === 'http:') {
      hints.push('Mixed content: this page is HTTPS but the middleware URL is http://. Use the https:// Railway URL.');
    }
  } catch {
    hints.push('Middleware URL looks invalid — must be like https://your-app.up.railway.app');
  }
  if (!navigator.onLine) hints.push('Device reports it is offline.');
  if (hints.length === 0) {
    hints.push('Hit: ' + url + '. Likely causes: phone blocking Railway, flaky cellular, or middleware is waking up. Tap Settings → Test to verify /health.');
  }
  return base + ' — ' + hints.join(' ');
}

// Fetch with a 45s timeout and one automatic retry on transient network
// failures. Mobile networks (especially cellular) often drop the first
// request to a cold endpoint; a retry usually succeeds.
async function fetchWithRetry(url, init, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch (err) {
    const isNetwork = err && (err.name === 'TypeError' || err.name === 'AbortError');
    if (isNetwork && attempt === 0) {
      // Warm up the middleware with a quick health ping, then retry.
      try { await fetch(state.endpoint + '/health', { cache: 'no-store' }); } catch {}
      await new Promise((r) => setTimeout(r, 600));
      return fetchWithRetry(url, init, attempt + 1);
    }
    throw new Error(describeFetchError(err, url));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Stage / mood helpers ----------
function setStage(state, sub) {
  els.stateText.textContent = state;
  if (sub !== undefined) els.subStateText.textContent = sub;
}

function setMood(mood) {
  state.mood = mood || 'neutral';
  els.portrait.setAttribute('data-mood', state.mood);
}

// ---------- Audio + lip-sync + waveform ----------
function ensureAudioCtx() {
  if (!state.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AC();
  }
  return state.audioCtx;
}

function playAudio(base64, mime, alignment) {
  return new Promise((resolve) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);

    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    state.currentAudio = audio;

    // Pause the mic while she's speaking so the speaker feedback doesn't
    // get transcribed into the chat box. Restart it after playback ends.
    pauseRecognizerForPlayback();

    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    state.analyser = analyser;

    if (alignment && alignment.characters && alignment.character_start_times_seconds) {
      startLipSyncAligned(audio, alignment);
    } else {
      startLipSync();
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      stopLipSync();
      state.currentAudio = null;
      // Resume mic after her voice stops so the user can speak again.
      resumeRecognizerAfterPlayback();
      resolve();
    };
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);
    // Interrupt (e.g. tap 🎙 or "jayla stop") triggers pause; resolve so onSend continues.
    audio.addEventListener('pause', () => {
      if (!audio.ended && audio.currentTime > 0) finish();
    });

    audio.play().catch(() => { stopLipSync(); resumeRecognizerAfterPlayback(); resolve(); });
  });
}

let lipRAF = 0;
let waveRAF = 0;

// Approximate mouth-openness per character. Higher = wider opening.
// Vowels open most; plosives/stops closed; silence fully closed.
const VISEME_MAP = {
  a: 1.0, A: 1.0,
  e: 0.7, E: 0.7,
  i: 0.4, I: 0.4, y: 0.45, Y: 0.45,
  o: 0.9, O: 0.9,
  u: 0.75, U: 0.75,
  w: 0.55, W: 0.55,
  r: 0.35, R: 0.35,
  l: 0.3,  L: 0.3,
  n: 0.2,  N: 0.2,
  m: 0.1,  M: 0.1,
  b: 0.1,  B: 0.1, p: 0.1, P: 0.1,
  f: 0.2,  F: 0.2, v: 0.2, V: 0.2,
  s: 0.25, S: 0.25, z: 0.25, Z: 0.25,
  t: 0.25, T: 0.25, d: 0.25, D: 0.25,
  k: 0.3,  K: 0.3,  g: 0.3,  G: 0.3,
  h: 0.4,  H: 0.4,
  c: 0.3,  C: 0.3,
  j: 0.3,  J: 0.3,
  x: 0.3,  X: 0.3,
  q: 0.35, Q: 0.35,
  ' ': 0, '.': 0, ',': 0, '!': 0, '?': 0, ';': 0, ':': 0, '"': 0, "'": 0,
  '\n': 0, '\t': 0,
};

function startLipSyncAligned(audioEl, alignment) {
  stopLipSync();
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  if (!chars || !starts || !ends) { startLipSync(); return; }

  // Smoothed current value so the mouth doesn't jitter.
  let current = 0;

  const loop = () => {
    const t = audioEl.currentTime;
    // Binary search for the active char (indices are ordered by start time).
    let lo = 0, hi = chars.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t && t <= ends[mid]) { idx = mid; break; }
      if (t < starts[mid]) hi = mid - 1; else lo = mid + 1;
    }

    let target = 0;
    if (idx >= 0) {
      const ch = chars[idx];
      const base = VISEME_MAP[ch];
      target = base === undefined ? 0.35 : base;

      // Progress 0..1 through the current character; shape it with a small
      // bell so each phoneme has a rise-and-fall, not a flat held open mouth.
      const dur = Math.max(0.001, ends[idx] - starts[idx]);
      const p = Math.min(1, Math.max(0, (t - starts[idx]) / dur));
      const bell = 1 - Math.abs(2 * p - 1);       // triangle 0..1..0
      target *= 0.55 + 0.45 * bell;
    }

    // Low-pass smoothing
    current += (target - current) * 0.35;
    const v = current.toFixed(3);
    els.mouth.style.setProperty('--mouth', v);
    els.avatarJaw.style.setProperty('--mouth', v);

    lipRAF = requestAnimationFrame(loop);
  };
  lipRAF = requestAnimationFrame(loop);
  startWaveform();
}

function startLipSync() {
  stopLipSync();
  const analyser = state.analyser;
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);

  const loop = () => {
    analyser.getByteFrequencyData(data);
    // Focus on voice band (~100–1200 Hz). With 48k sampleRate & fftSize 512,
    // bin width ≈ 94Hz, so bins 1..13 roughly cover that.
    let sum = 0;
    for (let i = 1; i < 14; i++) sum += data[i];
    const avg = sum / 13 / 255;                  // 0..1
    const level = Math.min(1, Math.max(0, avg * 2.2)); // gentle gain
    const lvlStr = level.toFixed(3);
    els.mouth.style.setProperty('--mouth', lvlStr);
    els.avatarJaw.style.setProperty('--mouth', lvlStr);
    lipRAF = requestAnimationFrame(loop);
  };
  lipRAF = requestAnimationFrame(loop);
  startWaveform();
}

function stopLipSync() {
  if (lipRAF) cancelAnimationFrame(lipRAF);
  lipRAF = 0;
  els.mouth.style.setProperty('--mouth', '0');
  els.avatarJaw.style.setProperty('--mouth', '0');
  stopWaveform();
}

function startWaveform() {
  const canvas = els.waveform;
  const ctx2d = canvas.getContext('2d');
  const analyser = state.analyser;
  if (!analyser) return;
  const data = new Uint8Array(analyser.fftSize);

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * devicePixelRatio;
    canvas.height = r.height * devicePixelRatio;
  };
  resize();

  const draw = () => {
    analyser.getByteTimeDomainData(data);
    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    const grad = ctx2d.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0,   '#2bd7ff00');
    grad.addColorStop(0.5, '#2bd7ffcc');
    grad.addColorStop(1,   '#7c5cff00');
    ctx2d.strokeStyle = grad;
    ctx2d.lineWidth = 2 * devicePixelRatio;
    ctx2d.beginPath();
    const step = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      const y = h / 2 + v * h * 0.45;
      const x = i * step;
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    waveRAF = requestAnimationFrame(draw);
  };
  waveRAF = requestAnimationFrame(draw);
}

function stopWaveform() {
  if (waveRAF) cancelAnimationFrame(waveRAF);
  waveRAF = 0;
  const canvas = els.waveform;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- Voice input + wake/sleep hotwords ----------

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function toggleListening() {
  // If she is mid-sentence, tap = interrupt. Keeps the mic state unchanged.
  if (state.currentAudio) {
    interruptSpeaking();
    return;
  }
  if (state.listening) stopListening();
  else startListening();
}

// Mute the mic while TTS audio plays so the speaker feedback loop doesn't
// transcribe her own voice into the chat box.
function pauseRecognizerForPlayback() {
  state.pausedForPlayback = true;
  setListenMode('speaking');
  if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
  state.pendingTranscript = '';
  const rec = state.recognizer;
  if (rec && state.recognizerRunning) {
    try { rec.abort ? rec.abort() : rec.stop(); } catch {}
  }
}

function resumeRecognizerAfterPlayback() {
  state.pausedForPlayback = false;
  if (!state.listening) { setListenMode('off'); return; }
  setListenMode('awake');
  const rec = state.recognizer;
  if (rec && !state.recognizerRunning) {
    // Small delay so the audio element fully tears down.
    setTimeout(() => {
      if (!state.listening || state.pausedForPlayback) return;
      try { rec.start(); }
      catch {
        // Recognizer got into a bad state — rebuild it.
        state.recognizer = null;
        startListening();
      }
    }, 300);
  }
}

function startListening() {
  const SR = getSpeechRecognition();
  if (!SR) {
    alert(
      'Voice input is not supported in this browser.\n\n' +
      'Works in: desktop Chrome/Edge, Android Chrome.\n' +
      'Does NOT work in: iOS Safari, Firefox, most in-app browsers.'
    );
    return;
  }
  if (!window.isSecureContext) {
    alert('Microphone requires HTTPS. Open this site via https:// (GitHub Pages is fine).');
    return;
  }
  if (state.recognizer) { try { state.recognizer.stop(); } catch {} state.recognizer = null; }

  // CRITICAL: rec.start() MUST run synchronously inside the click handler so
  // the user-gesture activation is preserved. Do NOT wrap this in a
  // getUserMedia().then(...) — that breaks the gesture window on some
  // Chrome versions and silently refuses mic permission.
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    state.listening = true;
    state.recognizerRunning = true;
    els.micBtn.setAttribute('aria-pressed', 'true');
    els.micBtn.classList.remove('hint');
    setListenMode(state.listenMode === 'asleep' ? 'asleep' : 'awake');
    setHeard('mic open — say something');
  };

  rec.onaudiostart  = () => setHeard('hearing audio…');
  rec.onspeechstart = () => setHeard('speech detected…');
  rec.onsoundstart  = () => { /* low-level sound detected */ };
  rec.onnomatch     = () => setHeard('heard something but couldn\u2019t transcribe');

  rec.onerror = (e) => {
    console.warn('Speech recognition error:', e.error, e);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      state.listening = false;
      setListenMode('off');
      alert('Microphone permission was denied.\n\n' +
        'Android Chrome: tap \u22ee \u2192 Site settings \u2192 Microphone \u2192 Allow, then reload and tap \ud83c\udf99.\n' +
        'Desktop Chrome: click the \ud83d\udd12 in the address bar \u2192 Microphone \u2192 Allow, then reload.');
    } else if (e.error === 'audio-capture') {
      state.listening = false;
      setListenMode('off');
      alert('No microphone detected. Check that a mic is connected and selected as the default input.');
    } else if (e.error === 'network') {
      // Speech recognition in Chrome uses Google servers — a network hiccup
      // stops the session. We'll auto-restart via onend.
      setHeard('network error \u2014 will retry');
    } else if (e.error === 'language-not-supported') {
      setHeard('language en-US not supported on this device');
    } else if (e.error === 'no-speech') {
      setHeard('no speech heard \u2014 keep talking');
    } else if (e.error === 'aborted') {
      // Benign; usually from a manual stop or a restart.
    } else {
      setHeard('mic error: ' + e.error);
    }
  };

  rec.onend = () => {
    state.recognizerRunning = false;
    // Don't auto-restart while she's talking — that would recapture her voice.
    if (state.pausedForPlayback) return;
    // Chrome ends the session periodically; auto-restart while still listening.
    if (state.listening) {
      // Small delay avoids InvalidStateError on fast restart.
      setTimeout(() => {
        if (state.pausedForPlayback || !state.listening) return;
        try { rec.start(); }
        catch (err) {
          console.warn('restart failed', err);
          // If the recognizer is unusable, build a fresh one next tick.
          state.recognizer = null;
          if (state.listening) setTimeout(() => { if (state.listening) startListening(); }, 300);
        }
      }, 200);
    } else {
      setListenMode('off');
    }
  };

  rec.onresult = onRecognitionResult;

  state.recognizer = rec;
  setHeard('starting mic…');
  setListenMode('awake');

  try {
    rec.start();
  } catch (err) {
    console.warn('Could not start recognizer:', err);
    // InvalidStateError means a previous session is still alive. Flush + retry.
    if (err && err.name === 'InvalidStateError') {
      setTimeout(() => {
        try { rec.start(); }
        catch (err2) { alert('Could not start voice recognition: ' + (err2.message || err2)); }
      }, 250);
    } else {
      alert('Could not start voice recognition: ' + (err && err.message ? err.message : err));
      setListenMode('off');
    }
  }
}

function stopListening() {
  state.listening = false;
  const rec = state.recognizer;
  state.recognizer = null;
  if (rec) { try { rec.stop(); } catch {} }
  if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
  setListenMode('off');
  els.micBtn.setAttribute('aria-pressed', 'false');
}

function normalizePhrase(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Fuzzy match — returns true if all words of `needle` appear in order within
// `haystack`, even with extra words between them. Tolerates Chrome mishearing
// "jayla" as "jayla", "jada", "jayla's", etc. (Also matches the bare name.)
function phraseMatch(haystack, needle) {
  if (!needle) return false;
  const h = haystack.split(' ').filter(Boolean);
  const n = needle.split(' ').filter(Boolean);
  if (n.length === 0) return false;
  let hi = 0;
  for (const word of n) {
    let found = false;
    while (hi < h.length) {
      const hw = h[hi++];
      if (hw === word || hw.startsWith(word) || word.startsWith(hw)) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

function onRecognitionResult(event) {
  // Safety: if she's mid-speech, drop anything the mic somehow captured.
  if (state.pausedForPlayback || state.currentAudio) return;

  // Build the newest final transcript and the latest interim.
  let finalText = '';
  let interimText = '';
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const res = event.results[i];
    if (res.isFinal) finalText += res[0].transcript + ' ';
    else interimText += res[0].transcript + ' ';
  }
  const heardRaw = (finalText + ' ' + interimText).trim();
  const heard = normalizePhrase(heardRaw);
  if (!heard) return;

  // Always echo what the mic is hearing so the user can tell it's working.
  setHeard(heardRaw);

  const wake  = normalizePhrase(state.wakePhrase);
  const sleep = normalizePhrase(state.sleepPhrase);
  const stop  = normalizePhrase(state.stopPhrase);

  // While she's talking, sleep/stop phrases interrupt her.
  if (state.listenMode === 'speaking') {
    if (phraseMatch(heard, stop) || phraseMatch(heard, sleep)) {
      interruptSpeaking();
      setListenMode('awake');
    }
    return;
  }

  // If the user previously said the sleep phrase, the mic still listens but
  // every utterance is ignored until the wake phrase is heard.
  if (state.listenMode === 'asleep') {
    if (phraseMatch(heard, wake)) {
      setListenMode('awake');
      const tail = extractTailAfter(heard, wake);
      state.pendingTranscript = tail;
      els.input.value = tail;
      autoGrow();
      armSilenceTimer(wake);
    }
    return;
  }

  // Default path: listenMode === 'awake'. Auto-send after a pause.

  // Sleep phrase → pause auto-sending but keep the mic open.
  if (phraseMatch(heard, sleep)) {
    if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
    state.pendingTranscript = '';
    els.input.value = '';
    autoGrow();
    setListenMode('asleep');
    return;
  }

  // Collect final pieces (stable transcript) into the pending prompt.
  if (finalText.trim()) {
    state.pendingTranscript = (state.pendingTranscript + ' ' + finalText).trim();
  }

  // Live preview = committed pending + current interim; strip a leading wake
  // phrase if the user still uses it out of habit.
  const preview = cleanPendingTranscript(
    (state.pendingTranscript + ' ' + interimText).trim(),
    wake
  );
  els.input.value = preview;
  autoGrow();

  armSilenceTimer(wake);
}

// Fires the pending transcript after a pause with no new speech.
// Shorter = snappier turn-taking, longer = more patient with slow speakers.
function armSilenceTimer(wake) {
  if (state.silenceTimer) clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => {
    state.silenceTimer = null;
    const text = cleanPendingTranscript(state.pendingTranscript, wake);
    state.pendingTranscript = '';
    if (text && !state.busy) submitVoiceText(text);
  }, 900);
}

function setHeard(text) {
  if (!els.listenHeard) return;
  els.listenHeard.textContent = text ? ('\u201C' + text + '\u201D') : '';
}

function cleanPendingTranscript(raw, wake) {
  let t = normalizePhrase(raw);
  if (wake && t.startsWith(wake)) t = t.slice(wake.length).trim();
  return t;
}

// Return everything said after the last word of `needle` within `haystack`.
// Both args are normalized lowercase strings.
function extractTailAfter(haystack, needle) {
  if (!needle) return '';
  const n = needle.split(' ').filter(Boolean);
  const h = haystack.split(' ').filter(Boolean);
  if (n.length === 0) return '';
  const last = n[n.length - 1];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] === last || h[i].startsWith(last) || last.startsWith(h[i])) {
      return h.slice(i + 1).join(' ').trim();
    }
  }
  return '';
}

function submitVoiceText(text) {
  els.input.value = text;
  autoGrow();
  // Reuse the existing send pipeline.
  onSend(new Event('submit'));
}

function interruptSpeaking() {
  if (state.currentAudio) {
    try { state.currentAudio.pause(); } catch {}
    state.currentAudio = null;
  }
  stopLipSync();
  setStage('ACTIVE', 'Stopped');
  setMood('neutral');
}

function setListenMode(mode) {
  state.listenMode = mode;
  const chip = els.listenChip;
  const txt = els.listenChipText;
  const btn = els.micBtn;
  if (!chip || !btn) return;

  chip.classList.remove('on', 'awake', 'asleep', 'speaking');
  btn.classList.remove('listening', 'awake', 'asleep', 'speaking');

  if (mode === 'off') {
    chip.style.display = 'none';
    setHeard('');
    return;
  }
  chip.style.display = '';

  if (mode === 'asleep') {
    chip.classList.add('on');
    btn.classList.add('listening');
    if (txt) txt.textContent = `RESTING — say "${state.wakePhrase}" to resume`;
  } else if (mode === 'awake') {
    chip.classList.add('awake');
    btn.classList.add('awake');
    if (txt) txt.textContent = `LISTENING — speak to send (say "${state.sleepPhrase}" to pause)`;
  } else if (mode === 'speaking') {
    chip.classList.add('speaking');
    btn.classList.add('speaking');
    if (txt) txt.textContent = `SPEAKING — say "${state.stopPhrase}" to interrupt`;
  }
}

// ---------- Go ----------
boot();
