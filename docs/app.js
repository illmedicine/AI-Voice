// AI Companion frontend for GitHub Pages.
// Talks to the Railway middleware (Grok -> ElevenLabs).

const LS = {
  endpoint: 'aivoice.endpoint',
  apiKey:   'aivoice.apiKey',
  voiceId:  'aivoice.voiceId',
  name:     'aivoice.name',
  history:  'aivoice.history',
  muted:    'aivoice.muted',
};

const $ = (id) => document.getElementById(id);

// ---------- State ----------
const state = {
  endpoint: localStorage.getItem(LS.endpoint) || '',
  apiKey:   localStorage.getItem(LS.apiKey)   || '',
  voiceId:  localStorage.getItem(LS.voiceId)  || '',
  name:     localStorage.getItem(LS.name)     || 'Companion',
  muted:    localStorage.getItem(LS.muted) === '1',
  history:  JSON.parse(localStorage.getItem(LS.history) || '[]'),
  busy: false,
  audioCtx: null,
  analyser: null,
  currentAudio: null,
  mood: 'neutral',
};

// ---------- DOM ----------
const els = {
  dialog:       $('settings'),
  cfgEndpoint:  $('cfgEndpoint'),
  cfgApiKey:    $('cfgApiKey'),
  cfgVoice:     $('cfgVoice'),
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
  els.testResult.textContent = '';
  els.dialog.showModal();
}

function saveSettings(e) {
  // Dialog's native submit will close; we persist values here.
  state.endpoint = els.cfgEndpoint.value.trim().replace(/\/+$/, '');
  state.apiKey   = els.cfgApiKey.value.trim();
  state.voiceId  = els.cfgVoice.value.trim();
  state.name     = els.cfgName.value.trim() || 'Companion';
  localStorage.setItem(LS.endpoint, state.endpoint);
  localStorage.setItem(LS.apiKey, state.apiKey);
  localStorage.setItem(LS.voiceId, state.voiceId);
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
    const url = state.endpoint +
      (state.muted ? '/v1/chat' : '/v1/grok-speak?return=json');

    const messages = toMessageArray(state.history);
    const body = { messages };
    if (state.voiceId) body.voiceId = state.voiceId;

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
      await playAudio(j.audio_base64, j.content_type || 'audio/mpeg');
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

function playAudio(base64, mime) {
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

    startLipSync();

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
    const level = Math.min(1, Math.max(0, avg * 1.8)); // gentle gain
    els.mouth.style.setProperty('--mouth', level.toFixed(3));
    lipRAF = requestAnimationFrame(loop);
  };
  lipRAF = requestAnimationFrame(loop);
  startWaveform();
}

function stopLipSync() {
  if (lipRAF) cancelAnimationFrame(lipRAF);
  lipRAF = 0;
  els.mouth.style.setProperty('--mouth', '0');
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
