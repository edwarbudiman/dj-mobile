# DJ Mobile — Checklist

Maintained by the orchestrator. Status: `[ ]` open · `[~]` built, awaiting review · `[x]` review passed.
Builder and reviewer: do not tick boxes; report to the orchestrator.

## Settled design (do not relitigate)

- Pure HTML + JS installable PWA. No build step, no framework, no npm runtime dependencies, no CDN. ES modules.
- Web Audio API. Each deck is an `AudioWorkletNode` with a custom playhead (fractional position, signed rate,
  interpolated reads) so audio can play backwards and at any speed. `AudioBufferSourceNode` is not used for decks.
- Tracks: file picker (`<input type=file accept="audio/*" multiple>`) → `decodeAudioData`; original file blobs
  stored in IndexedDB with metadata (name, duration, BPM, beat offset) so the library survives reloads.
- Canvas waveforms: full-track overview per deck plus a zoomed scrolling view with beat grid.
- BPM detection in a Web Worker; tap-tempo fallback and manual ±/×2/÷2 correction.
- Vinyl-mode pitch (tempo and pitch move together). No key lock in v1.
- Headphone cue is optional and split-mono (L = cue, R = master), off by default.
- Must run on https or localhost: ship a dependency-free local serve script and phone-access instructions.
- iOS: unlock audio on first user gesture, handle `interrupted`/`suspended` context states, work around the
  silent switch, no reliance on APIs Safari lacks.
- Mobile landscape-first two-deck layout, touch targets ≥ 44 px, multi-touch (two decks at once), no page
  scroll/zoom/selection while performing.

## File layout

```
index.html  manifest.webmanifest  sw.js  icons/
css/app.css
js/main.js            app bootstrap, wiring
js/audio/engine.js    AudioContext, unlock, master chain, mixer graph
js/audio/deck.js      Deck class (main-thread side of the worklet)
js/audio/deck-processor.js   AudioWorkletProcessor (playhead, scratch, ramps)
js/audio/bpm-worker.js       BPM + beat offset detection
js/audio/bpm-core.js         pure detection math (shared by worker and tests)
js/audio/peaks.js            waveform peak extraction (pure)
js/ui/*.js            deck view, waveform, jog/platter, mixer, library, toasts
js/store/db.js        IndexedDB wrapper
tools/serve.mjs       local http/https static server (Node, no deps)
tests/*.mjs           node --test unit tests for pure modules
README.md
```

## M1 — Foundation: load and play

- [~] 1.1 App shell: `index.html`, landscape two-deck layout + center mixer, portrait shows usable stacked layout or rotate hint
- [~] 1.2 Audio engine: single AudioContext, unlock overlay ("Tap to start"), resume on `statechange`/visibility
- [~] 1.3 Deck worklet: sample-accurate playhead, play/pause with short ramps (no clicks), seek, end-of-track stop, position reports to main thread
- [~] 1.4 Track loading: file picker → decode → transfer channel data to worklet; loading/decoding state; decode-error toast
- [~] 1.5 Library: IndexedDB persistence of blobs + metadata, list, load to deck A/B, delete; graceful fallback when IDB unavailable/quota exceeded (session-only)
- [~] 1.6 Transport: Play/Pause, Cue (set/return, hold-to-preview), time elapsed/remaining
- [~] 1.7 Mixer: per-deck volume, crossfader (equal-power), 3-band EQ per deck, master gain + limiter (DynamicsCompressor) to prevent clipping
- [~] 1.8 `tools/serve.mjs`: serves the app on 0.0.0.0, prints LAN URLs, correct MIME types, optional https with a self-signed cert

## M2 — Visualization and tempo

- [ ] 2.1 Peak extraction (off main thread or chunked) + overview waveform with playhead, tap/drag to seek
- [ ] 2.2 Zoomed scrolling waveform centered on playhead, smooth at 60 fps via rAF with interpolated position
- [ ] 2.3 BPM detection worker (onset envelope + autocorrelation, 70–180 range folding) + first-beat offset
- [ ] 2.4 Beat grid drawn on zoomed waveform; BPM readout shows effective BPM (base × pitch); beat-phase indicator per deck
- [ ] 2.5 Tap tempo, ×2, ÷2, ±0.1 nudge, grid shift; edits persisted to library metadata
- [ ] 2.6 Pitch fader (±8 % default, range toggle ±16 %), double-tap reset, pitch-bend nudge buttons (hold)
- [ ] 2.7 SYNC: match tempo to the other deck (and align phase when both have grids); disabled with explanation when BPM unknown

## M3 — Scratching

- [ ] 3.1 Platter/jog UI per deck with rotation tied to playhead (33⅓ rpm equivalent)
- [ ] 3.2 Touch-scratch: finger on platter grabs the record; angular delta → playhead delta; worklet follows target with smoothing; plays in reverse
- [ ] 3.3 Release: spin back up to play rate with inertia (or stay stopped if deck paused)
- [ ] 3.4 Scratch by dragging the zoomed waveform as well
- [ ] 3.5 Multi-touch: scratch one deck while moving crossfader / other deck; pointer capture; `pointercancel` handled; no stuck "grabbed" state
- [ ] 3.6 Audio quality: interpolation + rate smoothing so slow scratches do not zipper or click; silence when rate ≈ 0

## M4 — Mixing extras, PWA, hardening

- [ ] 4.1 Per-deck filter knob (LP/HP sweep) and hot cues (4 per deck, persisted)
- [ ] 4.2 Loop: auto-loop 1/2/4/8 beats (needs grid), exit
- [ ] 4.3 Optional split-mono headphone cue with per-deck CUE buttons and cue/master mix
- [ ] 4.4 PWA: manifest, icons, service worker precache with versioned cache, works offline after first load, update flow does not strand old cache
- [ ] 4.5 iOS quirks: silent-switch workaround, `interrupted` state recovery, safe-area insets, no double-tap zoom, wake lock where available
- [ ] 4.6 Memory guard: warn on very long/large files; free previous buffer on reload; two decks of 10-min tracks must work on a phone
- [ ] 4.7 Built-in demo loops (synthesized in-app, two different BPMs) so the app is playable with zero files
- [ ] 4.8 README: run locally, open on a phone (LAN + https options), install to home screen, controls guide, known limits
- [ ] 4.9 Unit tests (`node --test tests/`) for bpm-core, peaks, crossfader curve, sync math, playhead math; all green

## M5 — Final verification

- [ ] 5.1 Orchestrator hostile self-review: edge cases, cross-system effects, missing fallbacks; findings fixed or documented
- [ ] 5.2 End-to-end smoke in a real browser: load, play, waveform, scratch, mix
- [ ] 5.3 Final report: what was done, how to run on a phone

## M6 — GitHub Pages hosting (added by user mid-run)

- [ ] 6.1 `git init`, `.gitignore` (.vscode, node_modules, OS junk, .cert, review scratch, audio files), first commit
- [ ] 6.2 Public repo `edwarbudiman/dj-mobile` created and pushed with the existing gh login
- [ ] 6.3 Pages enabled from `main` branch root; empty `.nojekyll` present
- [ ] 6.4 Every asset, worklet, worker, manifest and service-worker path is relative; manifest `start_url` and `scope` are `./`; app works under `/dj-mobile/`
- [ ] 6.5 Commit and push after each milestone passes review (M1 · M2 · M3 · M4 · M5)
- [ ] 6.6 Live check: https://edwarbudiman.github.io/dj-mobile/ returns 200, worklet and service worker load there
- Rule: never push secrets or audio files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review log

(one line per review round: milestone, verdict, open findings)
