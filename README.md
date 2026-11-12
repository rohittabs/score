<div align="center">

<img src="icon-192.png" width="104" height="104" alt="Score">

# Score

**A free Guitar Pro and MuseScore player built for practice.**
Play it slow, loop the hard bars, mute the guitar and take its place.

### [Open Score](https://rohittabs.github.io/score)

![license](https://img.shields.io/badge/license-MIT-555555?style=flat-square)
![price](https://img.shields.io/badge/price-free%20forever-2FBF71?style=flat-square)
![formats](https://img.shields.io/badge/Guitar%20Pro-3%20to%208-22b8cf?style=flat-square)
![musescore](https://img.shields.io/badge/MuseScore-3%20and%20later-22b8cf?style=flat-square)
![account](https://img.shields.io/badge/account-not%20needed-7c3aed?style=flat-square)
![AI](https://img.shields.io/badge/AI-none-555555?style=flat-square)
![tracking](https://img.shields.io/badge/tracking-none-555555?style=flat-square)
![works](https://img.shields.io/badge/works-offline-3B82F6?style=flat-square)

[Take the two minute tour](https://rohittabs.github.io/score/slides.html) · [Everything Score does](https://rohittabs.github.io/score/about.html)

</div>

---

## What is this?

Score opens Guitar Pro and MuseScore files in a browser and plays them back with the tab and notation scrolling along. It is made for learning songs, so the controls that matter for practice are always one tap away: tempo, loop, metronome, and a mute and solo button for every track.

Nothing is uploaded. The file is read by the browser on the device, and after the first visit the whole app works with no internet connection.

**Live link:** https://rohittabs.github.io/score

---

## New in v1.2

### MuseScore files

Score now opens **`.mscz`** and **`.mscx`** files saved by MuseScore 3, MuseScore 4 or later, straight from the MuseScore folder. No export step is needed.

The file is translated inside the browser into MusicXML, the same way MuseScore's own export does it, and then shown and played like any other song. Notes, rests, tuplets, grace notes, ties, slurs, lyrics, chord symbols, dynamics, tempo marks, repeats, first and second endings, D.C., D.S., coda and fine, octave lines, transposing instruments and drum parts come across. Guitar and bass tab keeps its strings and frets, with bends, slides, hammer-ons, pull-offs, let ring, palm mute and vibrato.

How it was checked: 133 test scores from MuseScore's own repository were opened in Score and compared note by note with MuseScore's MusicXML export of the same files. 121 came out identical and the average match was 96%. All 760 MuseScore 3 and later test files open and play.

Files saved by MuseScore 2 or older are not supported. Score says so clearly: open them in MuseScore 3 or 4 and save them again, or export MusicXML.

### Ukulele

**Ukulele** is now a fifth choice under **Guitar sound**, recorded from a real tenor ukulele (FreePats, CC0).

- Ukulele parts are recognised automatically: a track named ukulele or uke, or a guitar type track with four strings tuned between C3 and C5 (soprano, concert and tenor GCEA, low G and baritone DGBE all count). In **Original** they now play on the ukulele instead of a nylon guitar
- Pick **Ukulele** to hear the guitar parts of any song on a ukulele. Notes below middle C move up an octave or two so the guitar part stays inside the ukulele's range
- **Acoustic**, **Electric** and **Nylon** change ukulele parts too, for anyone who wants to hear a ukulele part on a guitar

### Tabs for open songs

Every song you open gets its own tab above the music, like a web browser.

- Open a second file and the first stays open in its tab. Click a tab to switch
- Drop or pick several files at once and each one opens in a tab
- Each tab keeps its own tempo, loop, track mix, bars per row, playback position and scroll position
- Switch with `Shift` + `Left` and `Right`. Close a tab with its **×**, a middle click, or `Delete` on a focused tab. Closing the last tab goes back to the start screen
- The open tabs come back the next time Score opens, also offline
- Opening a file that is already open just switches to its tab. A file with the same name but new content (after editing it in Guitar Pro or MuseScore) replaces its old tab

### Bars per row

A new **Bars per row** control under **Display**: **Auto**, or exactly **1** to **6** bars on every line. Busy bars full of sixteenth notes get room to breathe with 2 or 3 per row. The choice is remembered for each song, because only some songs need it. It applies to the **Page** layout.

### Fixed

- Song credits that span several lines in a Guitar Pro file (copyright, music, words) were drawn on top of each other at the end of the page. They are now joined into one line
- A song opened scrolled slightly past its title. It now opens at the top

---

## The sound

### Five guitar sounds

The **Guitar sound** switch in the side panel changes every guitar and ukulele track in the song with one tap:

| Choice | What you hear |
|---|---|
| **Original** | Every track with the instrument written in the file. Ukulele parts on a ukulele |
| **Acoustic** | Steel string acoustic guitar |
| **Electric** | Clean electric guitar, sampled from a real guitar through an amp |
| **Nylon** | Nylon string classical guitar |
| **Ukulele** | Tenor ukulele. Guitar parts move up into its range |

Bass, drums, keys and every other instrument stay as written. The switch works while the song is playing and keeps the position and the loop. The choice is remembered for the next visit.

### The sound bank

Score ships its own sound bank assembled from four freely licensed sources, picked instrument by instrument after measuring them:

| Instruments | Source | Why |
|---|---|---|
| Clean electric guitar | FreePats FSBS Electric Guitar (CC0) | 13 notes recorded from a real guitar, each ringing for about nine seconds |
| Ukulele | FreePats Ukulele (CC0) | 13 notes recorded from a tenor ukulele, each ringing out naturally |
| Nylon, steel, jazz, muted, overdrive and distortion guitars, all basses, standard drum kit | MuseScore_General, based on FluidR3 (MIT) | Studio recordings with natural decay, the same sounds MuseScore uses |
| Everything else: 112 more instruments and 12 more drum kits | GeneralUser GS (its own free licence) | A complete and well balanced General MIDI set at a small size |

The bank is about 17.5 MB. It is downloaded once, with a progress bar, and kept on the device in its own cache, so later visits and app updates do not download it again.

A light **room reverb** (on by default, one button to turn it off) and a safety limiter sit between the synthesizer and the speakers, so instruments do not sound bone dry and a full band does not crackle on loud passages.

---

## What the app can do

| Feature | Details |
|---|---|
| **Every Guitar Pro version** | `.gp` (Guitar Pro 7 and 8), `.gpx` (Guitar Pro 6), `.gp5`, `.gp4`, `.gp3` |
| **MuseScore** | `.mscz` and `.mscx` from MuseScore 3, 4 and later. Also MusicXML (`.xml`, `.musicxml`, `.mxl`) and Capella (`.capx`) |
| **Drag and drop** | Drop a file anywhere on the page, or use **Open**. Drop or pick several at once and each opens in its own tab |
| **Tabs** | One tab per open song. Each keeps its own tempo, loop, mix, bars per row and position. The open tabs come back on the next visit |
| **Tempo** | 25% to 200% in steps of 5%. Pitch never changes. The real BPM is shown beside the percentage, for example `71 bpm (95)` |
| **Loop a section** | Three ways: drag across bars in the music, type bar numbers in the Loop panel, or press `[` and `]` while it plays. **This bar** loops the bar under the cursor |
| **Metronome** | On or off. Follows every tempo and time signature change in the file |
| **Count-in** | One bar of clicks before playback starts |
| **Mute and solo** | An **M** and **S** button on every track |
| **Track volume** | A slider per track, from silent to 150% |
| **Show tracks** | Tick the tracks to read. Click a track name to show only that one. **Show all** shows the full score |
| **Guitar sound** | Original, Acoustic, Electric, Nylon or Ukulele for all guitar and ukulele tracks at once |
| **Room reverb** | A short, bright room. One button, remembered |
| **Master volume** | One slider for everything |
| **Notation** | Tab and standard notation together, tab only, or notation only |
| **Layout** | Pages, or one continuous horizontal strip |
| **Bars per row** | Auto, or a fixed 1 to 6 bars on every line of the page. Remembered for each song |
| **Zoom** | 50% to 200% |
| **Follow along** | A bar highlight and a beat cursor follow playback and the page scrolls with them. Click any note to jump there |
| **Position bar** | Drag to any point in the song. Shows elapsed and total time and the current bar |
| **Library** | Every opened file is saved on the device and can be reopened offline |
| **Practice memory** | For each song Score remembers the tempo, the loop, the bars per row, and which tracks were muted, soloed, turned down and shown |
| **Themes** | Dark and light |
| **Keyboard shortcuts** | Everything important has a key. Press `?` in the app |
| **Offline** | A service worker keeps the app, the music font and the sound bank on the device |
| **Installable** | Add to a home screen or Dock and it opens in its own window. On Chrome and Edge it can also register as an app that opens Guitar Pro and MuseScore files |
| **Demo riff** | A short four track riff is built in, to try the controls without a file |

Not supported: Guitar Pro 1 and 2 files (`.gtp`), which no browser library reads, and files saved by MuseScore 2 or older (open and save them again in MuseScore 3 or 4).

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play or pause |
| `S` | Stop and go back to the start |
| `L` | Loop on or off |
| `[` and `]` | Set the loop start and end at the current bar |
| `Esc` | Clear the loop |
| `M` | Metronome on or off |
| `C` | Count-in on or off |
| `-` and `+` | Slower or faster by 5% |
| `0` | Back to 100% |
| `Left` and `Right` | Previous or next bar |
| `Home` | Jump to the start |
| `Shift` + `Left` and `Right` | Previous or next tab |
| `O` | Open files (each opens in a tab) |
| `T` | Show or hide the side panel |
| `?` | Show all shortcuts |

---

## Files in this repository

```
README.md              ← this file
LICENSE                ← MIT
index.html             ← the app page
slides.html            ← a two minute scrollable tour, with what is new in this release
about.html             ← a scrollable deck of everything Score does, not tied to a version
css/score.css          ← styles, dark and light themes
js/score.js            ← all app logic
js/musescore.js        ← reads MuseScore files (.mscz, .mscx) by translating them to MusicXML
sw.js                  ← service worker, makes the app work offline
manifest.webmanifest   ← lets phones and computers install it as a real app
Logo.png               ← the Score mark, large
logo.svg               ← the Score mark, vector
icon-512.png           ← app icon and social preview
icon-192.png           ← app icon
icon-maskable-512.png  ← app icon for Android adaptive icons
apple-touch-icon.png   ← home screen icon for iPhone and iPad
favicon.png            ← browser tab icon
sounds/score.sf3       ← the sound bank (about 17.5 MB)
sounds/LICENSES.md     ← licences of the four sound sources
vendor/alphatab/       ← alphaTab 1.9.0 (rendering and synthesizer) and the Bravura music font
tools/soundbank/       ← the Python scripts that assembled the sound bank
.nojekyll              ← tells GitHub Pages to serve the files as they are
```

Plain HTML, CSS and JavaScript. No build step, no server, no database, and no requests to anyone else's servers.

---

## How to install

Open this link in a browser: **https://rohittabs.github.io/score**

The first visit downloads the sound bank (about 17.5 MB), so do it once on Wi-Fi. After that Score opens instantly and works offline.

### iPhone or iPad

**Safari:**
1. Open **Safari** and go to the link above
2. Tap the **Share button** (the square with an arrow pointing up)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**
5. An icon named **Score** appears on the home screen. Open the app from this icon afterward

To open a song, tap **Open** and pick the Guitar Pro or MuseScore file from the Files app.

### Android phone or tablet

**Chrome:**
1. Open **Chrome** and go to the link above
2. Tap the **three dots** in the top right corner
3. Tap **Add to Home screen** or **Install app**
4. Tap **Install**

### Mac

**Safari:**
1. Open **Safari** and go to the link above
2. Click **File** in the menu bar, then **Add to Dock**

**Chrome:**
1. Open **Chrome** and go to the link above
2. Click the **install icon** at the right end of the address bar, then **Install**

### Windows

**Chrome or Edge:**
1. Go to the link above
2. Click the **install icon** in the address bar (in Edge: three dots, **Apps**, **Install this site as an app**)
3. Click **Install**

Bookmarking works everywhere too.

---

## How to use the app

### Open a song

- Drag a Guitar Pro or MuseScore file onto the page, or click **Open**, or press `O`
- No file at hand? Click **Try the demo riff**
- The first track is shown. Use the **Tracks** panel to show others

### Work with several songs

- Every song opens in a tab above the music. Click a tab to switch, or press `Shift` + `Left` / `Right`
- The **+** at the end of the tab row opens more files
- Each tab remembers its own tempo, loop, mix, bars per row and where you were
- Close a tab with its **×** or a middle click. The song stays in the **Library**
- Close Score and open it again: the same tabs are back

### MuseScore files

- Open `.mscz` or `.mscx` files directly. They are the files MuseScore saves, usually in a folder called **MuseScore4/Scores** (or **MuseScore3/Scores**) in Documents
- Everything that plays and reads well comes across: notes and rhythms, tab with strings and frets, guitar techniques, lyrics, chord symbols, dynamics, tempo, repeats and endings
- MuseScore's own page layout (page breaks, spacing, fonts) is not copied. Score lays the music out itself, so **Bars per row** and **Zoom** work the same as for Guitar Pro files
- A file from MuseScore 2 or older shows a message. Open it in MuseScore 3 or 4 and save it, then open it in Score

### Slow it down

- Drag the tempo slider, or use the **-** and **+** buttons beside it
- The button on the right shows the percentage and the real BPM. Click it to return to 100%

### Loop a section

- **Drag** across the bars you want in the music. The selection is highlighted and Loop turns on
- Or open the side panel, type a start and end bar under **Loop section**, and click **Set loop**
- Or press `[` at the first bar and `]` at the last bar while the song plays
- **This bar** loops the bar that is playing right now
- The **Loop** button in the transport turns repeating on and off without losing the selection
- **Clear** or `Esc` removes the selection

### Play along

- Turn on **Metronome** for a click, and **Count-in** for one bar of clicks before the start
- Press **M** on the guitar track to mute it and play its part yourself
- Press **S** on a track to hear it alone
- Use the small slider under a track to turn it up or down
- **Reset mix** puts every track back to normal

### Choose a guitar sound

- In the side panel under **Guitar sound**, pick **Acoustic**, **Electric**, **Nylon** or **Ukulele**
- **Original** goes back to the instruments written in the file, with ukulele parts on a ukulele
- **Reverb** turns the room sound on or off

### Change what you see

- **Tab + Score**, **Tab**, or **Score**
- **Page** or **Horizontal**
- **Bars per row**: **Auto**, or 1 to 6. Pick a lower number when a song looks crowded. Each song remembers its own choice
- **Zoom** with the - and + buttons
- The moon button in the top bar switches between dark and light

### Come back later

- Click **Library** to see every song opened on this device
- Click a song to reopen it in a tab. Its tempo, loop, bars per row and track mix come back with it
- Songs that are open in a tab are marked
- Click the **×** on a song to remove it from this device. Its tab closes too

---

## Data and privacy

- Guitar Pro and MuseScore files are read by the browser on the device. They are never uploaded
- The library is stored in the browser (IndexedDB), on that device only
- There is no account, no analytics, no advertising and no AI service
- The only downloads are the app's own files from GitHub Pages
- Clearing browser data removes the library and the downloaded sounds, so keep the original files somewhere safe

---

## Running it yourself

Score has to be served over `http://` or `https://`. Opening `index.html` directly from a folder will not work, because browsers refuse to start the background workers the player needs from a `file://` address.

```bash
cd score
python3 -m http.server 8000
# then open http://localhost:8000/
```

### Updating the live site

When any app file changes, raise `CACHE_VERSION` in `sw.js` (for example to `score-v1.2.1`). People who already have Score get the new version on their next visit.

The sound bank has its own cache name, `score-sounds-v2`, set in both `sw.js` and `js/score.js`. Leave it alone unless `sounds/score.sf3` itself is replaced, so that updates do not make everyone download 17.5 MB again. (Version 1.2 replaced the bank to add the ukulele, which is why it moved from `score-sounds-v1` to `score-sounds-v2`. The old copy is deleted automatically.)

### Rebuilding the sound bank

`tools/soundbank/build_bank.py` assembles `score.sf3` from the four source sound sets. The header of that file lists where each one comes from. It needs Python with `numpy` and `soundfile`.

---

## Credits and licences

- **Score** is released under the MIT licence. See `LICENSE`
- **alphaTab** by Daniel Kuschny renders the music and runs the synthesizer. MPL-2.0, see `vendor/alphatab/LICENSE`. It prints a small "alphaTab.net" mark on longer scores
- **Bravura** music font by Steinberg. SIL Open Font License, see `vendor/alphatab/font/Bravura-OFL.txt`
- **Sound bank**: FreePats FSBS Electric Guitar (CC0), FreePats Ukulele recorded by Mateusz Dąbrowski (CC0), MuseScore_General by S. Christian Collins based on FluidR3 by Frank Wen (MIT), and GeneralUser GS by S. Christian Collins. Full texts in `sounds/LICENSES.md`
- Score is an independent project. It is not affiliated with Arobas Music (Guitar Pro) or MuseScore. The file formats are read so that people can practise with the files they already have

---

## Version history

- **1.2.1** Files can be picked on iPhone and iPad again. iOS greys out file types it does not know (.gp, .gp5, .mscz), so on those devices the picker now shows every file and Score checks the name itself. New `about.html` deck: everything Score does.
- **1.2.0** Opens MuseScore files (`.mscz`, `.mscx`, MuseScore 3 and later). Ukulele sound, and ukulele parts play on a ukulele. Tabs for open songs, each with its own tempo, loop, mix and position, restored on the next visit. Several files open at once. Bars per row (Auto or 1 to 6), remembered per song. Fixed overlapping multi-line credits and songs opening slightly scrolled.
- **1.1.0** New sound bank with recorded instruments. Guitar sound switch: Original, Acoustic, Electric, Nylon. Room reverb and output limiter. Sounds download once with a progress bar and are cached separately from the app. Fixed the blank screen when hiding the side panel. Fixed reopening songs from the library. New logo, favicon and app icons. Added the two minute tour.
- **1.0.0** First release. All Guitar Pro formats, drag and drop, tempo control, section loop, metronome and count-in, mute, solo and volume per track, track visibility, tab and notation views, zoom, themes, library with practice memory, offline support, installable app.
