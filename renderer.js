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

// Populate mic & speaker device lists
async function populateDeviceLists() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    micSelect.innerHTML = '';
    speakerSelect.innerHTML = '';

    mics.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Mic ${d.deviceId}`;
      micSelect.appendChild(opt);
    });

    outputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Speaker ${d.deviceId}`;
      speakerSelect.appendChild(opt);
    });
  } catch (err) {
    console.warn('Could not enumerate media devices:', err);
  }
}

async function connectRoom() {
  try {
    connectBtn.disabled = true;
    const identity = 'Player' + Math.floor(Math.random() * 1000);
    const roomName = 'test';

    statusEl.textContent = 'Generating token...';
    const token = await ipcRenderer.invoke('getToken', { identity, roomName });

    statusEl.textContent = 'Connecting...';
    room = new LiveKit.Room();
    await room.connect(serverUrl, token, { autoSubscribe: true });

    // Create audio track using the selected mic
    const micDeviceId = micSelect.value;
    localTrack = await LiveKit.createLocalAudioTrack({
      deviceId: micDeviceId,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    await room.localParticipant.publishTrack(localTrack);

    // After publishing, set the audio output / speaker if possible
    const speakerDeviceId = speakerSelect.value;
    if (speakerDeviceId && typeof room.setAudioOutputDevice === 'function') {
      try {
        await room.setAudioOutputDevice(speakerDeviceId);
      } catch (err) {
        console.warn('Could not set audio output device:', err);
      }
    }

    statusEl.textContent = `Connected as ${identity} in room "${roomName}"`;
    muteBtn.disabled = false;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error: ' + err.message;
    connectBtn.disabled = false;
  }
}

connectBtn.addEventListener('click', connectRoom);
muteBtn.addEventListener('click', async () => {
  if (!localTrack) return;
  if (localTrack.isMuted) {
    await localTrack.unmute();
    statusEl.textContent = 'Mic on';
  } else {
    await localTrack.mute();
    statusEl.textContent = 'Mic off';
  }
});

// Populate lists on page load
populateDeviceLists();