# Sound bank build tools

These two Python files assembled `sounds/score.sf3`. They are kept here so the bank can be rebuilt or changed later. The app itself does not use them.

- `sf2lib.py` reads SoundFont 2 and SF3 files and writes a new one from chosen presets.
- `build_bank.py` picks the presets and writes the bank.

## Sources to download first

Place these next to the scripts, with these folder names:

| Folder | Where it comes from |
|---|---|
| `GeneralUser-GS/` | https://github.com/mrbumpy409/GeneralUser-GS |
| `scoredit-sounds/` | https://github.com/hikashop-nicolas/scoredit-sounds (MuseScore_General split into one file per instrument) |
| `clean-small/` | The file `EGuitarFSBS-clean-bridge-small-SF2-20260807.7z` from the releases of https://github.com/freepats/electric-guitar-FSBS-clean, unpacked |
| `ukulele1/` | The FreePats Ukulele, version 2026-08-11 (http://freepats.zenvoid.org/), unpacked: `README.txt`, `Ukulele 20260811.sfz` and `samples/` |

## Build

```bash
pip install numpy soundfile
python3 build_bank.py score.sf3
```

## What the script does, and why

- alphaTab only plays samples flagged as mono, so stereo flags are removed.
- alphaTab ignores sample start offsets on compressed samples, so those offsets are cut into the audio itself.
- alphaTab applies the SoundFont attenuation value at face value. The source banks were balanced on synthesizers that apply 40% of it, so every attenuation value is multiplied by 0.4. Without this, instruments come out up to 17 dB apart.
- The electric guitar is 7 dB louder than its neighbours as recorded, so it is turned down by that much.
- Samples of 8192 frames or more are stored as Ogg Vorbis. Shorter ones stay uncompressed so that very short loops stay clean.
- The sample data is padded to an even length, because alphaTab does not skip RIFF pad bytes.
- General MIDI has no ukulele, so the ukulele is added on program 24 in two extra banks. Bank 8 plays every note at its real pitch, for ukulele parts. Bank 9 moves notes below middle C up by whole octaves (the sample's root key is lowered instead of stretching it), so a guitar part played on it still sounds like a ukulele. Score picks the bank itself.
- `--uke-atten` turns the ukulele down by the given number of centibels if it ever needs to be balanced again. The shipped bank uses 0: it measures within half a decibel of the nylon guitar.
