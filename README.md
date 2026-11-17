# DJ Mobile

Two decks, scratching, a mixer and beat sync in a web page you can use on a phone. Load your own music or play
the built-in demo loops. Everything runs on your device: no account, no upload, no tracking. Pure HTML and
JavaScript, no build step, no dependencies.

**Try it:** https://edwarbudiman.github.io/dj-mobile/ (works offline after the first visit).

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer, only to serve the files.

```
node tools/serve.mjs
```

Open http://localhost:8080, tap **Tap to start**, then open the Library and load a demo loop onto each deck.
Hold the phone in landscape. `npm run serve` does the same thing.

## Open it on a phone over Wi-Fi

Audio on a phone needs a secure page: the decks are AudioWorklets, and browsers only provide those on https
(or on `localhost`). A plain `http://192.168.x.x` address from another device will not work.

```
node tools/serve.mjs --https
```

1. The server prints a `Network: https://192.168.x.x:8080/` address. Open it on the phone (same Wi-Fi).
2. The certificate is self-signed, so the browser warns that the connection is not private. That is expected.
   Choose *Show details* then *visit this website* (Safari) or *Advanced* then *Proceed* (Chrome).
3. It needs the `openssl` command (macOS has it; Linux: `apt install openssl`).

A self-signed certificate is not trusted by the browser, so **the service worker and offline mode will not work
on that address**. Everything else does. For offline use, open the hosted version above once.

## Install it like an app

Offline mode and installing need the hosted https version (or localhost).

- **iPhone / iPad (Safari):** open the page, tap **Share**, then **Add to Home Screen**. It opens full screen.
- **Android (Chrome):** open the page, then the menu, **Install app** (or **Add to Home screen**).

After the first visit the app starts without a network. When a new version is published, the app downloads it in
the background and shows **Update ready: tap to reload**. Nothing changes under you until you tap it. For
debugging, add `?nosw` to the address to remove the service worker and its caches.

## Controls

Each side is a deck (A cyan, B pink). The middle column is the mixer.

| Control | What it does |
| --- | --- |
| **Play** | Play or pause. |
| **Cue** | Playing: jump back to the cue point and pause. Paused away from the cue point: set it here. Paused on the cue point: hold to preview, release to return. |
| **Platter** | Touch the record to stop it; turn it to scratch (one turn = 1.8 s of music). Let go and it spins back up to speed. Works with two fingers on two decks. |
| **Zoomed waveform** | Drag it sideways to scratch too; the view zooms in while you hold it. |
| **Overview strip** | Tap or drag to jump anywhere in the track. |
| **Pitch fader** | Drag for big moves; slide your finger sideways while dragging for fine control. Double-tap resets. |
| **Pitch readout** (the number) | Swipe up or down on it to move in 0.02 % steps. |
| **− / +** | Hold to bend the speed for a moment (nudge two tracks into time). |
| **Grid** | Opens ×2, ÷2, ±0.1 BPM, grid shift (10 ms steps) and the ±8 % / ±16 % pitch range. |
| **Tap** | Tap the beat to set the BPM and where the beats fall. |
| **Sync** | Matches this deck's tempo to the other and, when both play, lines up the beats. Needs a BPM on both decks. |
| **Filter** (Flt) | Knob in the mixer: left = low-pass, right = high-pass, centre = off. Double-tap to reset. |
| **Hi / Mid / Lo** | Three-band EQ knobs. Drag up or down; double-tap resets. Fully down kills the band. |
| **Volume faders** | Channel volume. |
| **Crossfader** | Blends deck A and B (equal power). |
| **Pads** | Swaps the platter for pads. The switch in the bottom-right pad changes between **Hot cues** and **Loops**. |
| Hot cues | Tap an empty pad to save the spot (snapped to the nearest beat when the beat grid is trustworthy). Tap a set pad to jump there (a paused deck stays paused). **Clear**, then a pad, removes it. Saved with the track. |
| Loops | 1, 2, 4 or 8 beats, starting on the beat at or before the playhead. Tap the lit size again, or **Exit**, to leave. **Loops need a beat grid** (a BPM): use Tap if the BPM is unknown. Scratching suspends a loop; letting go outside it ends it. |
| **Library** | Your tracks (Load A / Load B / Delete), **Add files**, master volume, and the demo loops. |
| Demo loops | Two original loops made in the app (Night Drive 122 BPM, Neon Floor 128 BPM) with known tempo, so you can try Sync and beatmatching with no files. |
| **Split headphone cue** | Library, then Settings. Off by default. It needs a **stereo-to-dual-mono splitter cable** (often sold as a "DJ splitter" or a "stereo to 2 mono" Y cable): it sends the phone's left channel to your headphones, which carry the **cue**, and the right channel to the speakers, which carry the **master**. A plain headphone Y splitter will not work (it copies the same stereo signal to both). Turns on a **PFL** button per deck and a **Mix** knob (left = more cue, right = more master). |

### BPM detection

The BPM is detected in the background when a track loads (about a second) and saved with the track. A **?** next
to the number means the app is not confident: check it by ear and correct it with **Tap**, **×2** or **÷2**.
Tapping always wins and is saved.

## Known limits

- **No key lock.** Changing the pitch changes the speed and the key together, like a turntable.
- **Memory.** A decoded track takes frames × channels × 4 bytes: 10 minutes of stereo is about 200–230 MB, and loading
  briefly needs about double. Two such tracks are near what a phone can do. The app asks before decoding a file over
  60 MB or a WAV/AIFF over 15 minutes, and tells you if the device runs out. Shorter tracks are safer.
- **iPhone quirks.** Audio starts only after a tap. A phone call or Siri pauses it; tap to bring the sound back. If
  iOS resets the audio engine, tap to restart and the tracks reload from your library. The silent switch is handled
  (the app asks iOS for the "playback" audio category).
- **Storage.** Tracks live in your browser's storage. Clearing site data deletes them. In private browsing the library
  lasts only for the session.
- **No recording or export**, and no streaming from music services.
- **Browsers:** a recent Safari (iOS/iPadOS/macOS 15 or newer), Chrome or Edge, or Firefox. It needs AudioWorklet and
  a secure page.

## Run the tests

```
npm test            # or: node --test
node tools/check.mjs
node tools/smoke-serve.mjs
```

`node --test` runs everything in about 15 seconds: tempo detection, waveform peaks, the crossfader and EQ curves,
sync math, the deck processor (scratching, loops), demo synthesis, the service worker and more.

## For developers

- Everything is ES modules loaded straight from the files; edit and reload.
- URLs are all relative, because the hosted app lives under `/dj-mobile/`.
- **Offline cache:** `sw.js` precaches every file under `js/`, `css/` and `icons/`, plus `index.html` and the
  manifest, in a cache named after a hash of those files. After changing any of them run `node tools/sw-hash.mjs`
  and paste the line it prints over the `VERSION` line in `sw.js`. `npm test` fails until you do (it also fails if a
  new file is missing from the `PRECACHE` list). Without this, users could be left on old code.
- Icons are generated: `node tools/make-icons.mjs`.
