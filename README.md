# Score

**Play it slow. Loop it. Own it.**

Score is a Guitar Pro player that runs entirely in the browser. Drop in a tab, slow it down, loop the hard bars, mute or solo tracks, and practice with a metronome. No account, no upload, no AI. After the first visit it works offline.

Live: `https://<your-github-username>.github.io/score/`

## Features

- Opens every Guitar Pro format alphaTab reads: `.gp` (Guitar Pro 7 and 8), `.gpx` (Guitar Pro 6), `.gp5`, `.gp4`, `.gp3`, plus MusicXML (`.xml`, `.musicxml`, `.mxl`) and Capella (`.capx`)
- Drag and drop anywhere on the page, or use Open / the file picker
- Full band playback with a built-in synthesizer (SONiVOX soundfont), tablature and standard notation rendered side by side
- Tempo from 25% to 200% in 5% steps, with the real BPM shown next to the percentage
- Loop a section three ways: drag across the bars with the mouse, type bar numbers in the Loop panel, or press `[` and `]` while playing
- Metronome on / off and a one-bar count-in
- Mute, solo and per-track volume for every track in the file; show one track or several in the sheet
- Tab only, score only, or both; page or horizontal layout; zoom; dark and light themes
- Local library: every file you open is kept in the browser (IndexedDB) so you can reopen it offline, and Score remembers the tempo, loop and track mix you last used for each song
- Installable as an app (PWA) on Mac, iPad, iPhone, Windows and Android; the service worker caches everything, including the soundfont

Guitar Pro 1 and 2 files (`.gtp`) are not supported by the alphaTab engine.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` | Stop and go to the start |
| `L` | Loop on / off |
| `[` / `]` | Loop start / end at the current bar |
| `Esc` | Clear the loop selection |
| `M` | Metronome on / off |
| `C` | Count-in on / off |
| `-` / `+` | Speed down / up by 5% |
| `0` | Speed back to 100% |
| `Left` / `Right` | Previous / next bar |
| `O` | Open a file |
| `T` | Show / hide the side panel |
| `?` | Shortcut help |

Click a beat in the music to jump there. Drag across beats to select a loop range.

## Running it

Score needs to be served over `http://` or `https://`. Opening `index.html` straight from the Finder (`file://`) will not work, because the browser refuses to start the web workers and audio worklet that alphaTab uses.

Local preview:

```bash
cd score
python3 -m http.server 8000
# then open http://localhost:8000/
```

### Publish on GitHub Pages

1. Create a new public repository called `score`.
2. Push the contents of this folder to the `main` branch (the folder with `index.html` must be the repository root).
3. In the repository go to **Settings > Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://<your-github-username>.github.io/score/`.

To install it as an app: open the live URL, then use **Add to Dock** (Safari on Mac), **Add to Home Screen** (iPad / iPhone) or the install icon in the address bar (Chrome / Edge).

### Updating

When you change any file, bump `CACHE_VERSION` in `sw.js` (for example `score-v1.0.1`). Visitors get the new version on their next load and see a "Score was updated" message.

## Project layout

```
index.html               app shell
css/score.css            styles (dark and light themes)
js/score.js              player logic: loading, transport, loop, tracks, library, shortcuts
sw.js                    service worker (offline cache)
manifest.webmanifest     PWA manifest, file handler registration
icons/                   app icons
vendor/alphatab/         alphaTab 1.9.0 runtime, Bravura music font, SONiVOX soundfont
```

Everything is plain HTML, CSS and JavaScript. There is no build step and no dependency to install.

## Privacy

Files are read with the browser's File API and never leave your device. The local library lives in IndexedDB in your browser profile; clearing site data removes it. There is no analytics, no network call except loading the app's own files.

## Credits and licenses

- Score is released under the MIT License (see `LICENSE`).
- Rendering and playback by [alphaTab](https://alphatab.net) (MPL-2.0, `vendor/alphatab/LICENSE`). alphaTab 1.9 shows a small "alphaTab.net" mark on scores longer than 10 bars; this is part of the library.
- Music font: Bravura by Steinberg (SIL Open Font License, `vendor/alphatab/font/Bravura-OFL.txt`).
- Soundfont: SONiVOX EAS GM soundfont from the Android Open Source Project (Apache License 2.0, `vendor/alphatab/soundfont/LICENSE`).

## Version history

- **1.0.0** First release: all Guitar Pro formats, drag and drop, tempo control, section loop, metronome and count-in, mute / solo / volume per track, track visibility, tab / score views, zoom, themes, local library with per-song practice memory, offline support, installable PWA.
