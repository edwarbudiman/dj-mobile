# DJ Mobile — Checklist

Maintained by the orchestrator. Status: `[ ]` open · `[~]` built, awaiting review · `[x]` review passed.
Builder and reviewer: do not tick boxes; report to the orchestrator.

## Process rules (orchestrator: re-read after any context compaction)

- Orchestrator is Fable 5.2 in herdr tab `orchestrator` (w21:t3). It owns this file and all decisions.
- Loop per feature/milestone: builder implements → reviewer reviews → on FAIL back to the builder → on PASS the
  orchestrator ticks boxes, commits, pushes, then decides the next step. No stopping at milestone summaries.
- **One agent pair per feature** (user rule, applies after M1+M2): for each feature/milestone spawn a FRESH builder
  (`claude --model claude-sonnet-5-5`) and a FRESH reviewer (`claude --model claude-opus-5-5`), each in its own new
  herdr tab in w21, with unique names (`builder-m3`, `reviewer-m3`, …). Briefs must be self-contained (fresh sessions
  have no memory): point at CHECKLIST.md, the relevant files and prior review findings. After the feature passes
  review and is committed and pushed, end that pair's sessions and close their tabs (`herdr tab close <tab_id>`).
  Only close tabs the orchestrator created. Never kill an agent mid-turn.
- The original pair (`builder` w21:t4, `reviewer` w21:t5) finishes M1+M2, then is closed.
- **UI/UX quality** (user rule): every builder brief that touches UI (HTML, CSS, layout, controls, waveforms, visual
  design) must tell the builder to invoke the Skill tool with skill `frontend-design:frontend-design` as its FIRST
  step and follow it. Every reviewer brief must also judge UI/UX against that guidance (mobile ergonomics, touch
  targets, clarity, distinctive non-templated look), not only correctness.
- Agents are started with pre-approved single plain `node`/`ls`/`mkdir`/`grep`/`curl` commands only; tell them to
  avoid loops, pipes and `&&` chains so they do not stall on permission prompts.
- Tabs created by the orchestrator: w21:t4 (builder) and w21:t5 (reviewer) — CLOSED after M1+M2. Later pairs are listed in the review log.
  user's — never touch them.

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

- [x] 1.1 App shell: `index.html`, landscape two-deck layout + center mixer, portrait shows usable stacked layout or rotate hint
- [x] 1.2 Audio engine: single AudioContext, unlock overlay ("Tap to start"), resume on `statechange`/visibility
- [x] 1.3 Deck worklet: sample-accurate playhead, play/pause with short ramps (no clicks), seek, end-of-track stop, position reports to main thread
- [x] 1.4 Track loading: file picker → decode → transfer channel data to worklet; loading/decoding state; decode-error toast
- [x] 1.5 Library: IndexedDB persistence of blobs + metadata, list, load to deck A/B, delete; graceful fallback when IDB unavailable/quota exceeded (session-only)
- [x] 1.6 Transport: Play/Pause, Cue (set/return, hold-to-preview), time elapsed/remaining
- [x] 1.7 Mixer: per-deck volume, crossfader (equal-power), 3-band EQ per deck, master gain + limiter (DynamicsCompressor) to prevent clipping
- [x] 1.8 `tools/serve.mjs`: serves the app on 0.0.0.0, prints LAN URLs, correct MIME types, optional https with a self-signed cert

## M2 — Visualization and tempo

- [x] 2.1 Peak extraction (off main thread or chunked) + overview waveform with playhead, tap/drag to seek
- [x] 2.2 Zoomed scrolling waveform centered on playhead, smooth at 60 fps via rAF with interpolated position
- [x] 2.3 BPM detection worker (onset envelope + autocorrelation, 70–180 range folding) + first-beat offset
- [x] 2.4 Beat grid drawn on zoomed waveform; BPM readout shows effective BPM (base × pitch); beat-phase indicator per deck
- [x] 2.5 Tap tempo, ×2, ÷2, ±0.1 nudge, grid shift; edits persisted to library metadata
- [x] 2.6 Pitch fader (±8 % default, range toggle ±16 %), double-tap reset, pitch-bend nudge buttons (hold)
- [x] 2.7 SYNC: match tempo to the other deck (and align phase when both have grids); disabled with explanation when BPM unknown

## M3 — Scratching

- [x] 3.1 Platter/jog UI per deck with rotation tied to playhead (33⅓ rpm equivalent)
- [x] 3.2 Touch-scratch: finger on platter grabs the record; angular delta → playhead delta; worklet follows target with smoothing; plays in reverse
- [x] 3.3 Release: spin back up to play rate with inertia (or stay stopped if deck paused)
- [x] 3.4 Scratch by dragging the zoomed waveform as well
- [x] 3.5 Multi-touch: scratch one deck while moving crossfader / other deck; pointer capture; `pointercancel` handled; no stuck "grabbed" state
- [x] 3.6 Audio quality: interpolation + rate smoothing so slow scratches do not zipper or click; silence when rate ≈ 0

## M4 — Mixing extras, PWA, hardening

- [x] 4.1 Per-deck filter knob (LP/HP sweep) and hot cues (4 per deck, persisted)
- [x] 4.2 Loop: auto-loop 1/2/4/8 beats (needs grid), exit
- [x] 4.3 Optional split-mono headphone cue with per-deck CUE buttons and cue/master mix
- [x] 4.4 PWA: manifest, icons, service worker precache with versioned cache, works offline after first load, update flow does not strand old cache
- [x] 4.5 iOS quirks: silent-switch workaround, `interrupted` state recovery, safe-area insets, no double-tap zoom, wake lock where available
- [x] 4.6 Memory guard: warn on very long/large files; free previous buffer on reload; two decks of 10-min tracks must work on a phone
- [x] 4.7 Built-in demo loops (synthesized in-app, two different BPMs) so the app is playable with zero files
- [x] 4.8 README: run locally, open on a phone (LAN + https options), install to home screen, controls guide, known limits
- [x] 4.9 Unit tests (`node --test`, or `npm test`) for bpm-core, peaks, crossfader curve, sync math, playhead math; all green

## M5 — Final verification

- [x] 5.1 Orchestrator hostile self-review: edge cases, cross-system effects, missing fallbacks; findings fixed or documented
- [x] 5.2 End-to-end smoke in a real browser: load, play, waveform, scratch, mix
- [ ] 5.3 Final report: what was done, how to run on a phone

## M6 — GitHub Pages hosting (added by user mid-run)

- [x] 6.1 `git init`, `.gitignore` (.vscode, node_modules, OS junk, .cert, review scratch, audio files), first commit
- [x] 6.2 Public repo `edwarbudiman/dj-mobile` created and pushed with the existing gh login
- [x] 6.3 Pages enabled from `main` branch root; empty `.nojekyll` present
- [x] 6.4 Every asset, worklet, worker, manifest and service-worker path is relative; manifest `start_url` and `scope` are `./`; app works under `/dj-mobile/`
- [x] 6.5 Commit and push after each milestone passes review (pushed: M1+M2, M3, M4, M5)
- [x] 6.6 Live check: https://edwarbudiman.github.io/dj-mobile/ returns 200, worklet and service worker load there
- Rule: never push secrets or audio files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review log

(one line per review round: milestone, verdict, open findings)
- M1 round 1: FAIL. MAJOR M-1 (NaN seek/scratch target silences deck). MINOR m-1 edge/load clicks, m-2 gate tick on direction reversal, m-3 cue pointer id, m-4 mixer column overflow. Sent back to builder together with M2.
- M1 round 2 (re-verify): all M1 findings fixed, no regressions. M1 held open only until committed with M2.
- M2 round 1: FAIL. MAJOR: M-1 BPM precision/phase drift, M-2 dishonest confidence, M-3 pitch fader dead zone, U-1 no platter room / clipped rows at 667 and 844, U-2 grid panel covers transport. MINOR m-1..m-8, U-3..U-7. Sent back to builder (with frontend-design skill).
- M2 round 2: FAIL. All round-1 findings verified fixed. New MAJOR: double-tap reset fires on quick repeated drags (pitch fader, EQ knobs). MINOR: DnB 174→87, failed load leaves "analysing", platter 116 px at 667x300, per-deck pitch range vs sheet, analyzer cancel restarts other deck, overview hit area vs future scratch, fine-drag discoverability, bend + next to Play, popover hides remaining time. Orchestrator browser smoke (Chrome, localhost): load/waveform/BPM OK, worklet verified via OfflineAudioContext (fwd, reverse, half speed, scratch chase); live audible playback NOT verifiable on this machine.
- M2 round 3: FAIL. 10 of 11 items verified fixed. MAJOR: DnB double-tempo fix now doubles genuine 80–90 BPM tracks (85→170, hip-hop 82→164 at confidence 0.99). MINOR: pitch stepper halves 22 px tall, toasts cover zoom waveform. Back to builder.
- M2 round 4: PASS (reviewer, Opus). M1+M2 closed, committed and pushed. Carry-over minors for M3 brief: long load-error toast text, stale stepper comment at deck-view.js:203, README must say fader = big moves / readout swipe = fine.
- M3 pair: builder-m3 (w21:t6, pane w21:p6), reviewer-m3 (w21:t7, pane w21:p7). Close both tabs after M3 is pushed.
- M3 build 1 (builder-m3): 3.1–3.6 implemented, 98 tests pass. Orchestrator browser smoke: platter grab via pointer events moves the track by the expected 1.8 s/rev, grabbed visuals and dimmed Cue shown, release clears state, no console errors. Awaiting reviewer-m3.
- M3 round 1 (reviewer-m3): FAIL. MAJOR: glide reference snaps at direction reversals → per-sample speed jump (audible tick). MINOR: stop-bounce wow after abrupt stops, SYNC toast promises align-on-release that doesn't exist, grab-point latency offset. UX: waveform drag too coarse (34 ms/px), platter dead zone 15 % vs 36 % label, portrait scroll on scratch surface stops music, grabbed glow slightly busy. Back to builder-m3.
- M3 round 2 (reviewer-m3): PASS. Minors m-4 (reversal ducking), m-5 (mouse stuck grab when armed, portrait desktop), m-6 (120 ms hold too short), m-7 (release display jump) sent for one quick fix round before closing, since m-4/m-5 touch 3.5/3.6.
- M3 round 3 (reviewer-m3): PASS. m-4..m-7 fixed. m-8 (gate attack 0.7 ms) tried by orchestrator and reverted: it breaks the reversal-ducking test (dips to 0.37); kept 0.12 ms, whose worst step equals one ordinary 440 Hz sample step and is masked on music. M3 closed, committed, pushed; builder-m3/reviewer-m3 tabs closed.
- M4 pair: builder-m4 (w21:t8, pane w21:p8), reviewer-m4 (w21:t9, pane w21:p9). M4 runs as two loops with this pair: part A = 4.1, 4.2, 4.3, 4.7; part B = 4.4, 4.5, 4.6, 4.8, 4.9. Close both tabs after M4 is pushed.
- M4A build 1 (builder-m4): 4.1/4.2/4.3/4.7 implemented, 155 tests pass. Orchestrator browser smoke (667x375 + 667x300 frames): demos listed with DEMO tag and load with 122/128 BPM, split cue On shows PFL + Mix, Pads Cues/Loops pages fit, hot cue flag and 4-beat loop region drawn. UX issue found: the Pads page label "Cues" sits right beside the "Cue" transport button (easy to confuse). Awaiting reviewer-m4.
- M4A round 1 (reviewer-m4): FAIL. MAJOR: heard position not loop-aware (grab right after a wrap jumps out and drops the loop). MINOR: filter Q in dB, demo build slices too long for phones, Clear mode survives track load, Mix knob hidden in portrait, demo cache never freed (→4.6), node --test tests/ (→4.9). UX: Pads cycle (toggle + page switch), hc3/hc4 colours, orchestrator's Cue vs "Cues" label clash. Full report: tests/_review/m4a-report.md. Back to builder-m4.
- M4A build 2: fixes in, 162 tests in ~14 s. Orchestrator browser smoke: Pads button always reads "Pads", page switch in the grid, 4 distinct hot-cue colours with numbered flags, both demos built with max rAF frame gap 15 ms (no visible stall). Awaiting reviewer-m4 round 2.
- M4A round 2 (reviewer-m4): FAIL. Round-1 items verified; Worker path sound. New MAJOR M-2: loop fold misfires on Play from the loop start (heard position outside the loop for 60–130 ms). MINOR m-7 loop exit jump, m-8 hot-cue jump flash, m-9 demo worker timeout, m-10 mint hc4. Report: tests/_review/m4a-report-r2.md. Back to builder-m4.
- M4A round 3 (reviewer-m4): PASS. Loop-aware heard position verified end to end (real processor → Deck) at 20/60/150 ms; m-7..m-10 fixed. 4.1, 4.2, 4.3, 4.7 closed, committed and pushed. Carry to part B: m-5 demo PCM cache (4.6), m-6 test command wording (4.9), demo-worker.js/demo-loader.js in the SW precache (4.4), README notes (fader = big moves, readout swipe = fine; loops need a grid; split cue needs a Y cable).
- M4B build 1 (builder-m4): 4.4/4.5/4.6/4.8/4.9/6.4 implemented, 204 tests. Orchestrator browser check (Chrome, localhost): SW registered at scope ./, controls the page, cache dj-mobile-<hash> holds 46 files incl. worklet and both workers; manifest start_url/scope/id ./, 4 icons. With the server STOPPED (curl exit 7) a reload started the app offline, unlocked audio and loaded a demo at 122 BPM from cache. Awaiting reviewer-m4.
- M4B round 1 (reviewer-m4): FAIL. MAJOR B-1: long MP3/AAC mixes under 60 MB load with no memory warning (45-min 128 kbps → ~2 GB peak). MINOR b-2 second window runs mixed versions after update, b-3 every in-scope navigation gets index.html, b-4 failed load empties paused deck, b-5 iOS silent loop runs forever / not restarted after interruption, b-6 restore can overwrite a user load, b-7 "Y-split" wording wrong (needs a stereo-to-dual-mono DJ splitter), b-8 estimate ignores resampling, b-9 update reload cuts playing music. Report: tests/_review/m4b-report.md. Back to builder-m4.
- M4B build 2: all 9 items fixed, 211 tests, VERSION f9bff1610e. Orchestrator browser check of the update flow: new SW installed beside the old cache and waited, "Update ready: tap to reload" shown, tap → one reload, only dj-mobile-f9bff1610e cache remains, page controlled, bar gone. Awaiting reviewer-m4 round 2.
- M4B round 2 (reviewer-m4): PASS. c-1 hardening (stored duration, 1.5 s metadata timeout, size-guess threshold 25 min) applied by builder-m4, 213 tests, SW VERSION 9d52ae5ad8. M4 closed, committed, pushed; builder-m4/reviewer-m4 tabs closed.
- 6.6 live check (orchestrator, Chrome): https://edwarbudiman.github.io/dj-mobile/ → 200; sw.js, manifest (application/manifest+json), worklet, workers, icons all 200; SW active at scope /dj-mobile/, controls the page, cache dj-mobile-9d52ae5ad8 with 46 files; audio unlocked (worklet loaded) and the 128 BPM demo built in the Worker and loaded on deck B.
- 5.2 E2E (orchestrator, desktop Chrome, LIVE site https://edwarbudiman.github.io/dj-mobile/): unlock → load both demos → Play both (time advances 2.0 s per 2 s, real audio clock) → SYNC B to A (−4.69 % → 122.0 BPM) → crossfader drag → real mouse-drag scratch on platter A (rewound ~0.4 s, spun back up, kept playing, no stuck grab) → no app console errors. Real-phone touch/iOS audio not testable here.
- 5.1 hostile self-review findings (orchestrator): H-1 no navigator.storage.persist() → library can be silently evicted (Safari ~7-day ITP, Chrome storage pressure); H-2 accept="audio/*" hides .flac/.opus/.m4a on some Android pickers; H-3 an undecodable just-added file stays in the library as a dead entry; H-4 README gaps (memory-guard wording outdated, no note that iOS stops audio on lock/background, pitch fader direction, loading both decks at once doubles peak memory, storage eviction). Sent to a fresh M5 pair.
- M5 pair: builder-m5 (w21:tB, pane w21:pB), reviewer-m5 (w21:tC, pane w21:pC). Close both after the hostile-review fixes are pushed. Note: tab w21:tA ("4") was not created by the orchestrator — never touch it.
- M5 build 1 (builder-m5): H-1..H-4 implemented, 219 tests, VERSION c9b59f4b6d. Orchestrator browser check: accept list extended, storage line "10 MB of 10.0 GB used" shown; GAP found (O-1): persist() is requested only on a new add (db.js:80-91), so a user whose tracks were stored before this change is never protected and persisted() stays false. Awaiting reviewer-m5; O-1 to be bundled with its findings.
- M5 round 1 (reviewer-m5): FAIL. MAJOR-1: the H-3 auto-removal (orchestrator's own request) can delete good tracks (OOM reported as EncodingError, null old-Safari error, transient NotReadableError, closed context, post-decode failures). Decision: never auto-delete; mark the track "couldn't play" instead. MINOR-1 = O-1: request persistence on init when stored tracks exist. Report: tests/_review/m5-report.md. Back to builder-m5.
- M5 build 2: never auto-delete (mark "Couldn't play"), persistence requested on init for existing libraries; 220 tests, VERSION 185cd54de3. Orchestrator browser check: broken file kept and marked "Couldn't play", eviction notice shown after reload with an existing library. Small UX nit queued: one failure shows two toasts (raw browser "Unable to decode audio data" + app message). Test file removed via Delete. Awaiting reviewer-m5 round 2.
- M5 round 2 (reviewer-m5): PASS. Duplicate error toast fixed by builder-m5 and verified by the orchestrator in Chrome (one plain-language toast). VERSION 736b95d536, 220 tests. 5.1 closed, committed, pushed; builder-m5/reviewer-m5 tabs closed.
