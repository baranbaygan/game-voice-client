const { ipcRenderer } = require('electron');

function playChime(kind = 'join') {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;

  const mk = (freq, t0, dur, gain = 0.06, type = 'sine') => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq; o.type = type;
    g.gain.value = 0; g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  };

  if (kind === 'leave') {
    // descending minor (darker), slightly shorter
    mk(880,       now + 0.00, 0.16, 0.06, 'triangle');
    mk(739.99,    now + 0.06, 0.14, 0.055, 'triangle');
    mk(659.25,    now + 0.12, 0.12, 0.05, 'triangle');
  } else {
    // existing ascending major (brighter)
    mk(880,       now + 0.00, 0.18);
    mk(1108.73,   now + 0.06, 0.18);
    mk(1318.51,   now + 0.12, 0.18);
  }
}

function showToast({ title = 'Player joined', body = '', variant = 'join' } = {}) {
  const wrap = document.getElementById('wrap');
  const el = document.createElement('div');
  el.className = 'toast';
  const dotClass = variant === 'leave' ? 'dot leave' : 'dot';
  el.innerHTML = `
    <div class="${dotClass}"></div>
    <div class="text">
      <div class="title">${title}</div>
      <div class="body">${body}</div>
    </div>
  `;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }, 2400);

  // play sound for this variant
  playChime(variant);
}

ipcRenderer.on('overlay:show', (_e, payload) => {
  showToast(payload);
});
