// renderer.js
// Requires: nodeIntegration: true (dev)
// Main process must expose IPC handlers: getToken, getSetting, setSetting, getAppVersion

const LiveKit = require('livekit-client');
const { ipcRenderer } = require('electron');

const serverUrl   = 'ws://34.255.115.80:7880';

// UI elements
const statusEl    = document.getElementById('status');
const connectBtn  = document.getElementById('connect');
const muteBtn     = document.getElementById('mute');
const micSelect   = document.getElementById('micSelect');
const spkSelect   = document.getElementById('speakerSelect');
const micGain     = document.getElementById('micGain');
const micGainVal  = document.getElementById('micGainVal');
const autoChk     = document.getElementById('autoConnect'); // <-- NEW
const peerList    = document.getElementById('peerList');    // <-- NEW
const channelSelect = document.getElementById('channelSelect'); // existed in HTML

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

function log(...a){ console.log('[renderer]', ...a); }
function clearReconnectTimer(){ if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

function roomNameFromChannel() {
  const ch = channelSelect?.value || '1';
  return `ch-${ch}`;
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
  try { if (localTrack) { await localTrack.mute().catch(()=>{}); localTrack.stop(); } } catch {}
  try { rawStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { processedStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { sourceNode && sourceNode.disconnect(); } catch {}
  try { gainNode && gainNode.disconnect(); } catch {}
  try { destNode && destNode.disconnect(); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
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
  } catch {}
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
    opt.text  = d.label || `Mic ${d.deviceId}`;
    micSelect.appendChild(opt);
  });

  outs.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text  = d.label || `Speaker ${d.deviceId}`;
    spkSelect.appendChild(opt);
  });
}

// ---------- WebAudio graph (Mic -> Gain -> Destination) ----------
function buildAudioGraph(stream, initialGain = 1.0) {
  try { sourceNode && sourceNode.disconnect(); } catch {}
  try { gainNode && gainNode.disconnect(); } catch {}
  try { destNode  && destNode.disconnect(); } catch {}
  try { audioCtx  && audioCtx.close(); } catch {}

  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(stream);
  gainNode   = audioCtx.createGain();
  gainNode.gain.value = initialGain;
  destNode   = audioCtx.createMediaStreamDestination();

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

// ---------- Connected players (render) ----------
function renderPeers() {
  try {
    if (!peerList) return;

    // No room yet → clear UI
    if (!room) {
      peerList.innerHTML = '';
      return;
    }

    // activeSpeakers can be Participant[] or objects with sid/participant
    const activeSids = new Set(
      (room.activeSpeakers || [])
        .map(s => s?.sid || s?.participant?.sid || s?.participantSid || s?.participant?.identity || s?.identity)
        .filter(Boolean)
    );

    // room.participants may be:
    //  - Map<string, RemoteParticipant>
    //  - Array<RemoteParticipant> (older client builds in some wrappers)
    //  - undefined (race during early connect / SDK differences)
    let remoteList = [];
    if (room.participants && typeof room.participants.forEach === 'function') {
      // Map-like
      room.participants.forEach(p => remoteList.push(p));
    } else if (Array.isArray(room.participants)) {
      remoteList = room.participants.slice();
    } else if (room.getParticipants && typeof room.getParticipants === 'function') {
      // Some versions expose a getter
      remoteList = room.getParticipants() || [];
    } else {
      remoteList = []; // safest fallback
    }

    function liFor(p, isLocal) {
      const sid = p?.sid || p?.identity || '';
      const speaking = activeSids.has(sid);
      const classes = speaking ? 'speaking' : '';
      const name = p?.identity ?? 'Unknown';
      const you = isLocal ? ' (you)' : '';
      return `<li class="${classes}" data-sid="${sid}">
        <span class="dot"></span>
        <span class="name">${name}${you}</span>
      </li>`;
    }

    const items = [];
    if (room.localParticipant) items.push(liFor(room.localParticipant, true));
    remoteList.forEach(p => items.push(liFor(p, false)));

    peerList.innerHTML = items.join('');
  } catch (e) {
    console.warn('renderPeers failed:', e);
    // Don’t crash UI; just clear list
    if (peerList) peerList.innerHTML = '';
  }
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
    const identity = 'Player' + Math.floor(Math.random() * 1000);
    const roomName = roomNameFromChannel();

    statusEl.textContent = 'Generating token...';
    const token = await ipcRenderer.invoke('getToken', { identity, roomName });

    statusEl.textContent = 'Connecting...';
    log('Connecting', { serverUrl, identity, roomName });

    room = new LiveKit.Room();

    // ---- Room events (presence & media) ----
    room.on(LiveKit.RoomEvent.Connected, () => {
      log('RoomEvent: Connected');
      statusEl.textContent = 'Connected';
      clearReconnectTimer();
      renderPeers(); // initial render
    });

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
    room.on(LiveKit.RoomEvent.ParticipantConnected, () => renderPeers());
    room.on(LiveKit.RoomEvent.ParticipantDisconnected, () => renderPeers());
    room.on(LiveKit.RoomEvent.ActiveSpeakersChanged, () => renderPeers());

    // Optional: if you later add display names/metadata, re-render on change
    // room.on(LiveKit.RoomEvent.ParticipantMetadataChanged, () => renderPeers());

    // Media subscription just to ensure remote audio actually plays
    // 🔧 ALSO refresh on media events; some SDK builds don’t emit ParticipantConnected
    room.on(LiveKit.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log('TrackSubscribed from', participant.identity, pub.kind);
      try {
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
      } catch {}
      renderPeers(); // ⬅️ update roster
    });

    room.on(LiveKit.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      console.log('TrackUnsubscribed from', participant?.identity, pub?.kind);
      try { track.detach().forEach(el => el.remove()); } catch {}
      renderPeers(); // ⬅️ update roster
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
    if (autoChk?.checked) connectRoom().catch(()=>{});
    return;
  }

  // Switch: cleanly leave current room, then join the new one
  try {
    statusEl.textContent = `Switching to ${roomNameFromChannel()}...`;
    await cleanupLocalMedia();
    await room.disconnect(true); // true = stop all local tracks
  } catch (_) {}
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
    connectRoom().catch(() => {});
  }
});

// ---------- Init ----------
(async () => {
  populateChannels();
  await populateDeviceLists().catch(e => log('populateDeviceLists error:', e));
  await loadSavedMicGain().catch(() => {});
  const autoOn = await loadSavedAutoConnect();

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
