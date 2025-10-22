// renderer.js
// Requires: nodeIntegration: true (dev)
// Main process must expose IPC handlers: getToken, getSetting, setSetting, getAppVersion

const LiveKit = require('livekit-client');
const { ipcRenderer } = require('electron');

const serverUrl = 'ws://34.255.115.80:7880';

// UI elements
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const muteBtn = document.getElementById('mute');
const micSelect = document.getElementById('micSelect');
const spkSelect = document.getElementById('speakerSelect');
const micGain = document.getElementById('micGain');
const micGainVal = document.getElementById('micGainVal');
const autoChk = document.getElementById('autoConnect'); // <-- NEW
const peerList = document.getElementById('peerList');    // <-- NEW
const channelSelect = document.getElementById('channelSelect'); // existed in HTML
const usernameModal = document.getElementById('usernameModal');
const usernameInput = document.getElementById('usernameInput');
const usernameSaveBtn = document.getElementById('usernameSaveBtn');
const changeModal = document.getElementById('changeUsernameModal');
const changeInput = document.getElementById('changeUsernameInput');
const cancelChangeBtn = document.getElementById('cancelChangeBtn');
const saveChangeBtn = document.getElementById('saveChangeBtn');
const whoami = document.getElementById('whoami');

if (whoami) {
  whoami.style.cursor = 'pointer';
  whoami.title = 'Click to change your username';

  whoami.addEventListener('click', async () => {
    const oldName = await ipcRenderer.invoke('getSetting', 'username');
    changeInput.value = oldName || '';
    changeModal.style.display = 'flex';
    changeInput.focus();
  });
}

cancelChangeBtn.addEventListener('click', () => {
  changeModal.style.display = 'none';
});

saveChangeBtn.addEventListener('click', async () => {
  const newName = changeInput.value.trim();
  if (newName.length < 2) {
    changeInput.focus();
    return;
  }
  await ipcRenderer.invoke('setSetting', { key: 'username', value: newName });
  whoami.textContent = `Signed in as: ${newName}`;
  changeModal.style.display = 'none';

  // reconnect with new username
  if (room) {
    try { await room.disconnect(true); } catch { }
    connectRoom().catch(() => { });
  }
});

let room;
let localTrack;          // LiveKit LocalAudioTrack we publish
let rawStream;           // Raw getUserMedia stream
let processedStream;     // Stream after WebAudio gain
let audioCtx;
let sourceNode;
let gainNode;
let destNode;

let connecting = false;
let reconnectTimer = null;

// Per-remote audio element and volume memory
let remoteAudioEls = new Map();          // identity -> HTMLAudioElement
let remoteVolumes = new Map();          // identity -> 0..1

function log(...a) { console.log('[renderer]', ...a); }
function clearReconnectTimer() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

async function loadSavedVolumes() {
  const obj = await ipcRenderer.invoke('getSetting', 'volumes');
  if (obj && typeof obj === 'object') {
    for (const [id, v] of Object.entries(obj)) {
      const vol = Math.max(0, Math.min(1, Number(v)));
      if (!Number.isNaN(vol)) remoteVolumes.set(id, vol);
    }
  }
}
async function saveVolumes() {
  const obj = {};
  for (const [id, v] of remoteVolumes.entries()) obj[id] = v;
  await ipcRenderer.invoke('setSetting', { key: 'volumes', value: obj });
}

let roster = new Map(); // sid -> { sid, identity, isLocal, speaking }

let peerHeartbeat = null;
function startPeerHeartbeat() {
  if (peerHeartbeat) return;
  peerHeartbeat = setInterval(() => {
    if (!room || room.state === 'disconnected') return;
    renderPeers();
  }, 1000); // 1s; cheap and keeps UI honest
}
function stopPeerHeartbeat() {
  if (peerHeartbeat) { clearInterval(peerHeartbeat); peerHeartbeat = null; }
}

function roomNameFromChannel() {
  const ch = channelSelect?.value || '1';
  return `ch-${ch}`;
}

async function getOrAskUsername() {
  let name = await ipcRenderer.invoke('getSetting', 'username');
  if (name && String(name).trim().length >= 2) return String(name).trim();

  // show modal
  usernameModal.style.display = 'flex';
  usernameInput.value = '';
  usernameInput.focus();

  return await new Promise((resolve) => {
    const save = async () => {
      const v = String(usernameInput.value || '').trim();
      if (v.length < 2) { usernameInput.focus(); return; }
      await ipcRenderer.invoke('setSetting', { key: 'username', value: v });
      usernameModal.style.display = 'none';
      resolve(v);
    };
    usernameSaveBtn.onclick = save;
    usernameInput.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  });
}

function populateChannels() {
  if (!channelSelect) return;
  channelSelect.innerHTML = '';
  for (let i = 1; i <= 8; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.text = `${i}`;
    channelSelect.appendChild(opt);
  }
  if (!channelSelect.value) channelSelect.value = '1';
}

// optional: media cleanup when switching channels
async function cleanupLocalMedia() {
  try { if (localTrack) { await localTrack.mute().catch(() => { }); localTrack.stop(); } } catch { }
  try { rawStream?.getTracks().forEach(t => t.stop()); } catch { }
  try { processedStream?.getTracks().forEach(t => t.stop()); } catch { }
  try { sourceNode && sourceNode.disconnect(); } catch { }
  try { gainNode && gainNode.disconnect(); } catch { }
  try { destNode && destNode.disconnect(); } catch { }
  try { audioCtx && audioCtx.close(); } catch { }
  localTrack = null;
  rawStream = null;
  processedStream = null;
  sourceNode = gainNode = destNode = undefined;
  audioCtx = undefined;
}

// ---------- Settings persistence ----------
async function loadSavedMicGain() {
  try {
    const saved = await ipcRenderer.invoke('getSetting', 'micGainPercent');
    if (typeof saved === 'number' && !Number.isNaN(saved)) {
      micGain.value = String(saved);
      micGainVal.textContent = `${saved}%`;
      if (gainNode) gainNode.gain.value = Math.max(0, saved / 100);
      return saved;
    }
  } catch { }
  micGain.value = '100';
  micGainVal.textContent = '100%';
  return 100;
}
async function saveMicGain(pct) {
  try { await ipcRenderer.invoke('setSetting', { key: 'micGainPercent', value: pct }); }
  catch (e) { console.warn('saving micGain failed', e); }
}

async function loadSavedAutoConnect() {
  try {
    const val = await ipcRenderer.invoke('getSetting', 'autoConnect');
    const on = !!val;
    autoChk.checked = on;
    return on;
  } catch {
    autoChk.checked = false;
    return false;
  }
}
async function saveAutoConnect(on) {
  try { await ipcRenderer.invoke('setSetting', { key: 'autoConnect', value: !!on }); }
  catch (e) { console.warn('saving autoConnect failed', e); }
}

// ---------- Devices ----------
async function populateDeviceLists() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }); // to show labels
  } catch (e) {
    log('getUserMedia preflight (labels) failed (ok on first run):', e?.message || e);
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  log('Devices:', devices);

  const mics = devices.filter(d => d.kind === 'audioinput');
  const outs = devices.filter(d => d.kind === 'audiooutput');

  micSelect.innerHTML = '';
  spkSelect.innerHTML = '';

  mics.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = d.label || `Mic ${d.deviceId}`;
    micSelect.appendChild(opt);
  });

  outs.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = d.label || `Speaker ${d.deviceId}`;
    spkSelect.appendChild(opt);
  });
}

// ---------- WebAudio graph (Mic -> Gain -> Destination) ----------
function buildAudioGraph(stream, initialGain = 1.0) {
  try { sourceNode && sourceNode.disconnect(); } catch { }
  try { gainNode && gainNode.disconnect(); } catch { }
  try { destNode && destNode.disconnect(); } catch { }
  try { audioCtx && audioCtx.close(); } catch { }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(stream);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = initialGain;
  destNode = audioCtx.createMediaStreamDestination();

  sourceNode.connect(gainNode);
  gainNode.connect(destNode);

  processedStream = destNode.stream;
  return processedStream.getAudioTracks()[0];
}

// Create & publish processed track (with selected mic + slider gain)
async function publishProcessedTrack(deviceId, gainPercent) {
  const constraints = {
    audio: {
      deviceId: deviceId || undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false, // manual via WebAudio
    }
  };

  rawStream = await navigator.mediaDevices.getUserMedia(constraints);

  const linearGain = Math.max(0, (gainPercent ?? 100) / 100);
  const processedTrack = buildAudioGraph(rawStream, linearGain);

  let lkTrack;
  if (LiveKit.LocalAudioTrack && typeof LiveKit.LocalAudioTrack === 'function') {
    lkTrack = new LiveKit.LocalAudioTrack(processedTrack);
  } else {
    throw new Error('This SDK version cannot build LocalAudioTrack from a MediaStreamTrack.');
  }

  if (localTrack) {
    try {
      await room.localParticipant.unpublishTrack(localTrack);
      localTrack.stop();
    } catch (e) { log('unpublish old track error:', e); }
  }

  localTrack = lkTrack;
  await room.localParticipant.publishTrack(localTrack);
  log('Published processed mic (gain linear =', linearGain, ')');
}

// ---------- Reconnect logic ----------
function scheduleReconnect(attempt = 1) {
  if (!autoChk.checked) return;
  clearReconnectTimer();
  const delay = Math.min(30000, 1000 * Math.pow(2, attempt)); // 1s,2s,4s,...30s
  const secs = Math.round(delay / 1000);
  statusEl.textContent = `Reconnecting in ${secs}s (attempt ${attempt})...`;
  log(`Scheduling reconnect in ${secs}s (attempt ${attempt})`);

  reconnectTimer = setTimeout(async () => {
    try {
      await connectRoom(); // fresh token each time
      log('Reconnected via manual backoff');
    } catch (e) {
      log('Reconnect attempt failed:', e?.message || e);
      scheduleReconnect(attempt + 1);
    }
  }, delay);
}

function liForRemote(identity, sid, speaking) {
  const volPct = Math.round(((remoteVolumes.get(identity) ?? 1) * 100));
  return `<li class="${speaking ? 'speaking' : ''}" data-sid="${sid}">
    <span class="dot"></span>
    <span class="name">${identity}</span>
    <input class="peerVol" type="range" min="0" max="100" step="1"
           value="${volPct}" data-id="${identity}"
           style="margin-left:8px; width:110px;">
  </li>`;
}


function getRemoteParticipantsArray() {
  if (!room) return [];
  // Try common shapes first (v1/v2)
  const coll =
    room.participants ??
    room.remoteParticipants ??   // some builds
    room._participants ??        // very old/internal
    null;

  const out = [];

  if (coll?.forEach) {           // Map-like
    coll.forEach(p => out.push(p));
    return out;
  }
  if (coll?.values) {            // Map iterator
    for (const p of coll.values()) out.push(p);
    return out;
  }
  if (Array.isArray(coll)) {     // Array-like
    return coll.slice();
  }
  if (coll && typeof coll === 'object') {  // Plain object map
    for (const k of Object.keys(coll)) {
      const p = coll[k];
      if (p && (p.sid || p.identity)) out.push(p);
    }
    return out;
  }
  if (typeof room.getParticipants === 'function') {
    const arr = room.getParticipants() || [];
    return Array.isArray(arr) ? arr.slice() : [];
  }
  return [];
}

// ---------- Connected players (render) ----------
function renderPeers() {
  if (!peerList) return;
  if (!room) { peerList.innerHTML = ''; return; }

  // active speakers
  const activeSids = new Set(
    (room.activeSpeakers || [])
      .map(s => s?.sid || s?.participant?.sid || s?.participantSid || s?.identity)
      .filter(Boolean)
  );

  // read remotes robustly
  const remotes = getRemoteParticipantsArray();

  // Build set of current sids (for pruning)
  const currentSids = new Set(remotes.map(p => p?.sid).filter(Boolean));
  const lp = room.localParticipant;
  if (lp?.sid) currentSids.add(lp.sid);

  // PRUNE ghosts (fixes "disconnect doesn’t disappear")
  for (const sid of Array.from(roster.keys())) {
    if (!currentSids.has(sid)) roster.delete(sid);
  }

  // Ensure local entry
  if (lp) {
    roster.set(lp.sid, {
      sid: lp.sid,
      identity: lp.identity || 'You',
      isLocal: true,
      speaking: activeSids.has(lp.sid),
    });
  }

  // Ensure remotes
  for (const p of remotes) {
    const sid = p?.sid;
    if (!sid) continue;
    roster.set(sid, {
      sid,
      identity: p.identity || sid.slice(0, 6),
      isLocal: false,
      speaking: activeSids.has(sid),
    });
  }

  // Build DOM
  const items = [];

  // local first
  for (const entry of roster.values()) {
    if (!entry.isLocal) continue;
    items.push(`
      <li class="${entry.speaking ? 'speaking' : ''}" data-sid="${entry.sid}">
        <span class="dot"></span>
        <span class="name">${entry.identity} (you)</span>
      </li>
    `);
  }

  // remotes with volume slider
  for (const entry of roster.values()) {
    if (entry.isLocal) continue;
    const identityKey = entry.identity || entry.sid;
    const volPct = Math.round((remoteVolumes.get(identityKey) ?? 1) * 100);
    items.push(`
      <li class="${entry.speaking ? 'speaking' : ''}" data-sid="${entry.sid}">
        <span class="dot"></span>
        <span class="name">${entry.identity}</span>
        <input class="peerVol" type="range" min="0" max="100" step="1"
               value="${volPct}" data-id="${identityKey}"
               style="margin-left:8px; width:110px;">
      </li>
    `);
  }

  peerList.innerHTML = items.join('');

  // sliders -> audio & persist
  peerList.querySelectorAll('input.peerVol').forEach(sl => {
    sl.addEventListener('input', async () => {
      const identity = sl.getAttribute('data-id');
      const vol = Math.max(0, Math.min(100, Number(sl.value))) / 100;
      remoteVolumes.set(identity, vol);
      const el = remoteAudioEls.get(identity);
      if (el) el.volume = vol;
      try { await saveVolumes(); } catch { }
    });
  });

  console.log('[peers] roster=', Array.from(roster.values()).map(r => r.identity));
}

// ---------- Connect flow ----------
async function connectRoom() {
  if (connecting) {
    log('connectRoom ignored (already connecting)');
    return;
  }
  connecting = true;
  clearReconnectTimer();

  try {
    connectBtn.disabled = true;
    const identity = await getOrAskUsername();
    if (whoami) whoami.textContent = `Signed in as: ${identity}`;
    const roomName = roomNameFromChannel();

    statusEl.textContent = 'Generating token...';
    const token = await ipcRenderer.invoke('getToken', { identity, roomName });

    statusEl.textContent = 'Connecting...';
    log('Connecting', { serverUrl, identity, roomName });

    room = new LiveKit.Room();

    // ---- Room events (presence & media) ----
    room.on(LiveKit.RoomEvent.Reconnecting, () => {
      log('RoomEvent: Reconnecting');
      statusEl.textContent = 'Reconnecting...';
    });

    room.on(LiveKit.RoomEvent.Reconnected, () => {
      log('RoomEvent: Reconnected');
      statusEl.textContent = 'Connected';
      renderPeers();
    });

    room.on(LiveKit.RoomEvent.Disconnected, () => {
      log('RoomEvent: Disconnected');
      statusEl.textContent = 'Disconnected';
      connectBtn.disabled = false;
      muteBtn.disabled = true;
      renderPeers(); // clears list
      scheduleReconnect(1);
    });

    // Presence updates:
    room.on(LiveKit.RoomEvent.ParticipantConnected, (p) => {
      roster.set(p.sid, { sid: p.sid, identity: p.identity, isLocal: false, speaking: false });

      // 🔔 Notify overlay window + sound
      try {
        ipcRenderer.send('overlay:show', {
          title: 'Player joined your channel',
          body: p?.identity ? String(p.identity) : 'Unknown player'
        });
      } catch (_) {}

      renderPeers();
    });
    room.on(LiveKit.RoomEvent.ParticipantDisconnected, (p) => {
      const idKey = p?.identity || p?.sid;
      if (idKey) {
        const el = remoteAudioEls.get(idKey);
        if (el) { try { el.remove(); } catch { } }
        remoteAudioEls.delete(idKey);
      }
      if (p?.sid) roster.delete(p.sid);   // <-- critical
      renderPeers();

      // 🔔 Notify overlay with LEAVE variant
      try {
        ipcRenderer.send('overlay:show', {
          title: 'Player left your channel',
          body: p?.identity ? String(p.identity) : 'Unknown player',
          variant: 'leave' // <-- tells overlay to use red dot + leave sound
        });
      } catch (_) {}

    });


    // Active speakers
    room.on(LiveKit.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const active = new Set(speakers.map(s => s.sid || s.participant?.sid));
      for (const r of roster.values()) r.speaking = active.has(r.sid);
      renderPeers();
    });


    // Connection lifecycle
    room.on(LiveKit.RoomEvent.Connected, () => {
      // Reset roster on fresh connect so we don’t carry stale entries across rooms
      roster = new Map();
      if (room.localParticipant) {
        roster.set(room.localParticipant.sid, {
          sid: room.localParticipant.sid,
          identity: room.localParticipant.identity,
          isLocal: true,
          speaking: false,
        });
      }
      renderPeers();
    });

    room.on(LiveKit.RoomEvent.Reconnected, () => renderPeers());
    room.on(LiveKit.RoomEvent.Disconnected, () => { roster = new Map(); renderPeers(); });

    // Optional: if you later add display names/metadata, re-render on change
    // room.on(LiveKit.RoomEvent.ParticipantMetadataChanged, () => renderPeers());

    room.on(LiveKit.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log('TrackSubscribed from', participant.identity, pub.kind);
      // Ensure they are in roster (covers cases where ParticipantConnected wasn’t seen yet)
      if (participant?.sid) {
        roster.set(participant.sid, {
          sid: participant.sid,
          identity: participant.identity || participant.sid.slice(0, 6),
          isLocal: false,
          speaking: false,
        });
      }

      if (pub.kind === 'audio') {
        try {
          const el = track.attach();
          el.style.display = 'none';
          const idKey = participant.identity || participant.sid;
          const vol = remoteVolumes.get(idKey) ?? 1.0;
          el.volume = vol;
          remoteAudioEls.set(idKey, el);
          document.body.appendChild(el);
        } catch (e) { console.error('Attach error:', e); }
      }

      renderPeers();
    });

    room.on(LiveKit.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      console.log('TrackUnsubscribed from', participant?.identity, pub?.kind);

      // Detach and remove DOM nodes created for this track
      try { track.detach()?.forEach(el => { try { el.remove(); } catch { } }); } catch { }

      // Clean up per-remote audio element mapping (keyed by identity, fallback sid)
      if (pub?.kind === 'audio') {
        const idKey = participant?.identity || participant?.sid;
        if (idKey && remoteAudioEls.has(idKey)) {
          try { remoteAudioEls.get(idKey)?.remove?.(); } catch { }
          remoteAudioEls.delete(idKey);
        }
      }

      // If participant has no other subscribed tracks AND is not in room.participants, drop from roster
      const sid = participant?.sid;
      const idKey = participant?.identity || participant?.sid;

      // Is the participant still present in the room?
      const stillPresent = (() => {
        if (!room || !sid) return false;
        if (room.participants?.has) return room.participants.has(sid); // Map
        if (Array.isArray(room.participants)) return room.participants.some(p => p.sid === sid);
        if (typeof room.getParticipantBySid === 'function') return !!room.getParticipantBySid(sid);
        return true;
      })();

      // Does the participant have any subscribed publications left?
      const hasAnySubscribed = (() => {
        const pubs = [];
        if (participant?.trackPublications?.values) {
          for (const tp of participant.trackPublications.values()) pubs.push(tp);
        } else if (Array.isArray(participant?.trackPublications)) {
          pubs.push(...participant.trackPublications);
        } else if (participant?.tracks?.values) {
          for (const tp of participant.tracks.values()) pubs.push(tp);
        } else if (Array.isArray(participant?.tracks)) {
          pubs.push(...participant.tracks);
        }
        if (pubs.length === 0) return remoteAudioEls.has(idKey);
        return pubs.some(tp => (tp?.isSubscribed ?? tp?.subscribed ?? !!tp?.track));
      })();

      if (!stillPresent || !hasAnySubscribed) {
        try { roster.delete(sid); } catch { }
      }

      renderPeers();
    });



    room.on(LiveKit.RoomEvent.AudioPlaybackStatusChanged, async () => {
      log('RoomEvent: AudioPlaybackStatusChanged; canPlaybackAudio =', room.canPlaybackAudio);
      if (!room.canPlaybackAudio) {
        try { await room.startAudio(); } catch (e) { log('startAudio failed', e); }
      }
    });

    room.on(LiveKit.RoomEvent.MediaDevicesError, (err) => {
      log('RoomEvent: MediaDevicesError', err);
    });

    await room.connect(serverUrl, token, { autoSubscribe: true });
    renderPeers();                 // immediate
    setTimeout(renderPeers, 50);   // small tick later (covers SDKs that fill participants just after resolve)
    console.log('participants right after connect:',
      room.participants?.size ?? (Array.isArray(room.participants) ? room.participants.length : 'unknown'));
    log('Connected to LiveKit');

    const initialPct = parseInt(micGain.value, 10) || 100;
    await publishProcessedTrack(micSelect.value, initialPct);

    if (spkSelect.value && typeof room.setAudioOutputDevice === 'function') {
      try { await room.setAudioOutputDevice(spkSelect.value); }
      catch (e) { log('setAudioOutputDevice failed:', e?.message || e); }
    }

    statusEl.textContent = `Connected as ${identity} in room "${roomName}"`;
    muteBtn.disabled = false;
    renderPeers();

  } catch (err) {
    console.error('connectRoom error:', err);
    statusEl.textContent = 'Error: ' + (err?.message || err);
    connectBtn.disabled = false;
    renderPeers();
    scheduleReconnect(1);
    throw err;
  } finally {
    connecting = false;
  }
}

// ---------- UI handlers ----------

channelSelect.addEventListener('change', async () => {
  // If not connected yet and auto-connect is on, just connect.
  if (!room) {
    if (autoChk?.checked) connectRoom().catch(() => { });
    return;
  }

  // Switch: cleanly leave current room, then join the new one
  try {
    statusEl.textContent = `Switching to ${roomNameFromChannel()}...`;
    await cleanupLocalMedia();
    await room.disconnect(true); // true = stop all local tracks
  } catch (_) { }
  room = null;
  connectBtn.disabled = true;
  try {
    await connectRoom();
  } finally {
    connectBtn.disabled = false;
  }
});

connectBtn.addEventListener('click', async () => {
  log('Connect clicked');
  await connectRoom();
});

muteBtn.addEventListener('click', async () => {
  if (!localTrack) {
    log('Mute clicked but no localTrack');
    return;
  }
  if (localTrack.isMuted) {
    await localTrack.unmute();
    statusEl.textContent = 'Mic on';
    log('Local mic unmuted');
  } else {
    await localTrack.mute();
    statusEl.textContent = 'Mic off';
    log('Local mic muted');
  }
});

micGain.addEventListener('input', async () => {
  const pct = parseInt(micGain.value, 10);
  micGainVal.textContent = `${pct}%`;
  if (gainNode) gainNode.gain.value = Math.max(0, pct / 100);
  await saveMicGain(pct);
});

micSelect.addEventListener('change', async () => {
  if (!room) return;
  try {
    const pct = parseInt(micGain.value, 10) || 100;
    await publishProcessedTrack(micSelect.value, pct);
    log('Mic switched to', micSelect.value);
  } catch (e) { console.error('Mic switch failed:', e); }
});

spkSelect.addEventListener('change', async () => {
  if (!room || typeof room.setAudioOutputDevice !== 'function') return;
  try { await room.setAudioOutputDevice(spkSelect.value); log('Speaker switched to', spkSelect.value); }
  catch (e) { console.error('Speaker switch failed:', e); }
});

autoChk.addEventListener('change', async () => {
  await saveAutoConnect(autoChk.checked);
  if (autoChk.checked && !room) {
    connectRoom().catch(() => { });
  }
});

// ---------- Init ----------
(async () => {
  populateChannels();
  await populateDeviceLists().catch(e => log('populateDeviceLists error:', e));
  await loadSavedMicGain().catch(() => { });
  await loadSavedVolumes();
  const autoOn = await loadSavedAutoConnect();


  // Ensure username exists BEFORE autoconnect
  const identity = await getOrAskUsername();
  if (whoami) whoami.textContent = `Signed in as: ${identity}`;

  // Version badge
  try {
    const version = await ipcRenderer.invoke('getAppVersion');
    const badge = document.createElement('div');
    badge.textContent = `v${version}`;
    Object.assign(badge.style, {
      position: 'fixed', bottom: '8px', right: '10px',
      padding: '2px 6px', fontSize: '11px', fontFamily: 'system-ui, sans-serif',
      color: '#555', background: '#f2f2f2', border: '1px solid #ddd',
      borderRadius: '6px', opacity: '0.9', pointerEvents: 'none', zIndex: 9999,
    });
    document.body.appendChild(badge);
  } catch (e) { console.warn('Could not fetch app version:', e); }

  // Auto-connect after a short delay (let device lists/gain initialize)
  if (autoOn) {
    setTimeout(() => { connectRoom().catch(() => scheduleReconnect(1)); }, 300);
  }
})();
