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
};

const $ = (id) => document.getElementById(id);

// ---------- State ----------
const state = {
  endpoint: localStorage.getItem(LS.endpoint) || '',
  apiKey:   localStorage.getItem(LS.apiKey)   || '',
  voiceId:  localStorage.getItem(LS.voiceId)  || '',
  modelId:  localStorage.getItem(LS.modelId)  || '',
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
  testBtn:      $('testBtn'),
  testResult:   $('testResult'),
  settingsForm: $('settingsForm'),

  settingsBtn:  $('settingsBtn'),
  muteBtn:      $('muteBtn'),
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
  els.composer.addEventListener('submit', onSend);
  els.input.addEventListener('keydown', onInputKey);
  els.input.addEventListener('input', autoGrow);
  els.testBtn.addEventListener('click', testConnection);
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

  if (!state.endpoint || !state.apiKey) openSettings();
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
  els.testResult.textContent = '';
  els.dialog.showModal();
  // Populate voice/model dropdowns if we have creds configured.
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
  // Dropdown takes priority, manual override falls back.
  state.voiceId  = (els.cfgVoiceSelect.value || els.cfgVoice.value).trim();
  state.modelId  = els.cfgModelSelect.value.trim();
  state.useTimed = els.cfgUseTimed.checked;
  state.name     = els.cfgName.value.trim() || 'Companion';
  localStorage.setItem(LS.endpoint, state.endpoint);
  localStorage.setItem(LS.apiKey, state.apiKey);
  localStorage.setItem(LS.voiceId, state.voiceId);
  localStorage.setItem(LS.modelId, state.modelId);
  localStorage.setItem(LS.useTimed, state.useTimed ? '1' : '0');
  localStorage.setItem(LS.name, state.name);
  applyName();
  updateConnectionIndicator();
  setStage('ACTIVE', 'Waiting for prompt');
}

async function testConnection() {
  const ep = els.cfgEndpoint.value.trim().replace(/\/+$/, '');
  if (!ep) { els.testResult.textContent = 'Enter a URL first.'; return; }
  els.testResult.textContent = 'Pinging…';
  try {
    const r = await fetch(ep + '/health');
    const j = await r.json();
    if (r.ok && j.ok) {
      els.testResult.textContent =
        `OK — xai:${j.configured.xai ? '✓' : '✗'} elevenlabs:${j.configured.elevenlabs ? '✓' : '✗'} auth:${j.configured.auth ? '✓' : '✗'}`;
    } else {
      els.testResult.textContent = 'Reachable but unhealthy: ' + JSON.stringify(j);
    }
  } catch (e) {
    els.testResult.textContent = 'Failed: ' + e.message;
  }
}

function updateConnectionIndicator() {
  const ok = Boolean(state.endpoint && state.apiKey);
  els.connDot.classList.toggle('ok', ok);
  els.connDot.title = ok ? 'Configured' : 'Not configured';
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

    const r = await fetch(url, {
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

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      stopLipSync();
      state.currentAudio = null;
      resolve();
    });
    audio.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      stopLipSync();
      state.currentAudio = null;
      resolve();
    });

    audio.play().catch(() => { stopLipSync(); resolve(); });
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

// ---------- Go ----------
boot();
