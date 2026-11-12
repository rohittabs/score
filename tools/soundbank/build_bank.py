"""Build the Score sound bank (SF3: SoundFont 2 layout with Ogg Vorbis samples).

Sources
  GeneralUser GS 2.0.3 (S. Christian Collins)           everything that is not listed below
  MuseScore_General 0.2 (FluidR3 based, MIT)            guitars 24-26, 28-31, basses 32-39, standard drum kit
  FreePats FSBS Electric Guitar Clean (CC0)             program 27, the "Electric" sound
"""
import glob, io, json, sys
import numpy as np, soundfile as sf
from sf2lib import SF2, Builder

OUT = sys.argv[1] if len(sys.argv) > 1 else 'score.sf3'
COMPRESS = '--pcm' not in sys.argv

def vorbis(pcm, rate, level):
    x = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
    buf = io.BytesIO()
    try:
        sf.write(buf, x, rate, format='OGG', subtype='VORBIS', compression_level=level)
    except Exception:
        return None
    data = buf.getvalue()
    y, _ = sf.read(io.BytesIO(data), dtype='float32')
    return data if len(y) == len(x) else None   # loop points only stay valid when the length is preserved

GU = SF2('GeneralUser-GS/GeneralUser-GS.sf2')
FS = SF2(glob.glob('clean-small/*/*.sf2')[0])
MS_PROGRAMS = [24, 25, 26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39]
MS = {p: SF2(f'scoredit-sounds/gm/{p:03d}.sf3') for p in MS_PROGRAMS}
MS_DRUMS = SF2('scoredit-sounds/gm/drums.sf3')

b = Builder()
if COMPRESS:
    b.encoder = vorbis
# alphaTab's synth applies initialAttenuation at face value; the fonts were balanced on synths that apply 0.4 (EMU / FluidSynth)
b.attenuation_scale = 0.4
b.quality[id(FS)] = 0.2
b.quality[id(GU)] = 0.3
manifest = []
for program in range(128):
    if program == 27:
        b.add_preset(FS, 0, bank=0, program=27, name='Clean Electric Guitar', attenuation_cb=70); src = 'FreePats FSBS clean (CC0)'
    elif program in MS:
        m = MS[program]; b.add_preset(m, m.find(0, program)); src = 'MuseScore_General (MIT)'
    else:
        b.add_preset(GU, GU.find(0, program)); src = 'GeneralUser GS'
    manifest.append((0, program, b.phdr[-1][0], src))

b.add_preset(MS_DRUMS, MS_DRUMS.find(128, 0)); manifest.append((128, 0, 'Standard', 'MuseScore_General (MIT)'))
for i, p in enumerate(GU.presets[:-1]):
    if p.bank == 128 and p.program != 0:
        b.add_preset(GU, i); manifest.append((128, p.program, p.name, 'GeneralUser GS'))

by = {}
for (sid, si, so, eo), ni in b._sample_map.items():
    h = b.shdr[ni]; n = (h[2]-h[1]) * (1 if h[9] & 0x10 else 2)
    label = 'FSBS' if sid == id(FS) else ('GU' if sid == id(GU) else 'MS')
    by[label] = by.get(label, 0) + n
print({k: round(v/1048576, 2) for k, v in by.items()})
size = b.write(OUT, name='Score sound bank 1.0',
               comment='Assembled for Score (github.com/rohittabs/score) from GeneralUser GS 2.0.3 by S. Christian Collins, '
                       'MuseScore_General 0.2 (FluidR3 by Frank Wen, MIT) and FreePats FSBS Electric Guitar Clean (CC0). See LICENSE files.',
               copyright_='See bundled licence files: GeneralUser GS License v2.0, MIT (MuseScore_General / FluidR3), CC0 (FreePats)')
json.dump(manifest, open(OUT + '.json', 'w'), indent=0)
print(f'{OUT}: {size/1048576:.2f} MB, presets={len(b.phdr)}, instruments={len(b.inst)}, samples={len(b.shdr)} (ogg {b.stats["ogg"]}, pcm {b.stats["pcm"]})')
