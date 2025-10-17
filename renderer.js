const LiveKit = require('livekit-client');
const { ipcRenderer } = require('electron');

const serverUrl = 'ws://192.168.0.37:7880';
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const muteBtn = document.getElementById('mute');
const micSelect = document.getElementById('micSelect');
const speakerSelect = document.getElementById('speakerSelect');

let room;
let localTrack;

function log(msg, ...args) {
  console.log('[renderer]', msg, ...args);
}

// Populate mic & speaker device dropdowns
async function populateDeviceLists() {
  try {
    // Ask for mic permission first (so labels appear)
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.warn('Could not get mic permission when enumerating devices:', err);
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    log('Devices enumerated:', devices);
    const mics = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    micSelect.innerHTML = '';
    speakerSelect.innerHTML = '';

    mics.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Mic (${d.deviceId})`;
      micSelect.appendChild(opt);
    });

    outputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Speaker (${d.deviceId})`;
      speakerSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('Error enumerating devices:', err);
  }
}

// Instrumented connect logic
async function connectRoom() {
  try {
    connectBtn.disabled = true;
    statusEl.textContent = 'Generating token...';
    const identity = 'Player' + Math.floor(Math.random() * 1000);
    const roomName = 'test';
    const token = await ipcRenderer.invoke('getToken', { identity, roomName });

    statusEl.textContent = 'Connecting...';
    log('Connecting to room', serverUrl, 'as', identity, 'in room', roomName);

    room = new LiveKit.Room();
    // Instrument events
    room.on(LiveKit.RoomEvent.Connected, () => {
      log('RoomEvent: Connected');
      statusEl.textContent = 'Connected';
    });
    room.on(LiveKit.RoomEvent.Disconnected, () => {
      log('RoomEvent: Disconnected');
      statusEl.textContent = 'Disconnected';
      connectBtn.disabled = false;
      muteBtn.disabled = true;
    });
    room.on(LiveKit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      log('RoomEvent: TrackSubscribed', participant.identity, publication.kind, track.sid);
      try {
        const el = track.attach();  // returns an `<audio>` element for audio
        el.style.display = 'none';
        document.body.appendChild(el);
        log('Attached track element to DOM', el);
      } catch (attachErr) {
        console.error('Error attaching track:', attachErr);
      }
    });
    room.on(LiveKit.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      log('RoomEvent: TrackUnsubscribed', participant.identity, publication.kind, track.sid);
      try {
        track.detach().forEach(el => {
          if (el.parentNode) el.parentNode.removeChild(el);
        });
      } catch (detachErr) {
        console.warn('Error detaching track elements:', detachErr);
      }
    });
    room.on(LiveKit.RoomEvent.AudioPlaybackStatusChanged, () => {
      log('RoomEvent: AudioPlaybackStatusChanged, room.canPlaybackAudio =', room.canPlaybackAudio);
      // If playback is blocked (canPlaybackAudio = false), prompt user to call startAudio
      if (!room.canPlaybackAudio) {
        log('Audio playback is blocked. Need user gesture to start audio.');
        // Show a button to allow audio:
        const btn = document.createElement('button');
        btn.innerText = 'Enable Audio';
        btn.onclick = async () => {
          try {
            await room.startAudio();
            log('room.startAudio succeeded');
            btn.remove();
          } catch (e) {
            console.error('room.startAudio failed:', e);
          }
        };
        document.body.appendChild(btn);
      }
    });
    room.on(LiveKit.RoomEvent.MediaDevicesError, error => {
      log('RoomEvent: MediaDevicesError', error);
    });

    await room.connect(serverUrl, token, { autoSubscribe: true });
    log('Connected: after await room.connect');

    // Create local audio track using chosen mic
    const micDeviceId = micSelect.value;
    log('Creating local audio track with mic deviceId:', micDeviceId);
    localTrack = await LiveKit.createLocalAudioTrack({
      deviceId: micDeviceId,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    log('Local audio track created:', localTrack);

    await room.localParticipant.publishTrack(localTrack);
    log('Published local audio track');

    // Attempt to set output device / speaker if API available
    const speakerDeviceId = speakerSelect.value;
    log('Setting speaker/output device to:', speakerDeviceId);
    if (speakerDeviceId && typeof room.setAudioOutputDevice === 'function') {
      try {
        await room.setAudioOutputDevice(speakerDeviceId);
        log('Successfully set audio output device');
      } catch (err) {
        console.warn('Failed to set audio output device:', err);
      }
    } else {
      log('No room.setAudioOutputDevice API or no speaker selection');
    }

    statusEl.textContent = `Connected as ${identity} in room "${roomName}"`;
    muteBtn.disabled = false;

  } catch (err) {
    console.error('connectRoom error:', err);
    statusEl.textContent = 'Error: ' + (err.message || err);
    connectBtn.disabled = false;
  }
}

connectBtn.addEventListener('click', async () => {
  log('Connect button clicked');
  await connectRoom();
});

muteBtn.addEventListener('click', async () => {
  if (!localTrack) {
    log('Mute toggled but no localTrack exists');
    return;
  }
  if (localTrack.isMuted) {
    await localTrack.unmute();
    log('Unmuted localTrack');
    statusEl.textContent = 'Mic on';
  } else {
    await localTrack.mute();
    log('Muted localTrack');
    statusEl.textContent = 'Mic off';
  }
});

// On startup, populate devices
populateDeviceLists().catch(err => {
  console.error('populateDeviceLists error:', err);
});