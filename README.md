# Game Voice Client

Game Voice Client is an Electron desktop app for team voice chat in games. It connects to a LiveKit server, lets players join numbered voice channels, and provides basic controls for microphones, speakers, volume, mute state, and reconnect behavior.

The app also includes a small always-on-top overlay window that shows join and leave notifications while the client is running.

## Features

- Electron desktop client with a compact voice-control UI
- LiveKit room connection and audio publishing
- Numbered channel selection
- Microphone and speaker device selection
- Manual microphone gain control
- Per-player remote volume controls
- Saved username, audio gain, remote volumes, and auto-connect preference
- Join and leave overlay notifications with short sounds

## Requirements

- Node.js
- npm

## Getting Started

Install dependencies:

```sh
npm install
```

Start the Electron app:

```sh
npm start
```

On first launch, the app asks for a username and saves it in the Electron user data directory.

## Packaging

The project uses `electron-builder` for desktop packages.

Build a Windows portable package:

```sh
npm run pack:win
```

Build a Windows installer:

```sh
npm run build:win
```

Build a macOS directory package:

```sh
npm run pack:mac
```

Build a macOS DMG:

```sh
npm run build:mac
```

## Project Structure

- `main.js` - Electron main process, windows, settings storage, and LiveKit token generation
- `renderer.js` - main app UI logic, LiveKit connection handling, audio controls, and settings
- `index.html` - main desktop client UI
- `overlay.html` - transparent overlay window markup and styles
- `overlay.js` - overlay notification behavior and sounds
- `assets/` - app icons and other static assets

