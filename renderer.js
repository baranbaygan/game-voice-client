const LiveKit = require('livekit-client');
const { ipcRenderer } = require('electron');

const serverUrl = 'ws://192.168.0.37:7880';
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const muteBtn = document.getElementById('mute');

let room;
let localTrack;

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

    localTrack = await LiveKit.createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    await room.localParticipant.publishTrack(localTrack);

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