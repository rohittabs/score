"""Build the Score sound bank (SF3: SoundFont 2 layout with Ogg Vorbis samples).

Sources
  GeneralUser GS 2.0.3 (S. Christian Collins)           everything that is not listed below
  MuseScore_General 0.2 (FluidR3 based, MIT)            guitars 24-26, 28-31, basses 32-39, standard drum kit
  FreePats FSBS Electric Guitar Clean (CC0)             program 27, the "Electric" sound
  FreePats Ukulele 2026-08-11 (CC0)                     bank 8 program 24 "Ukulele" (real pitch) and
                                                        bank 9 program 24 "Ukulele (guitar parts)" (low notes folded up)

Usage: python3 build_bank.py score.sf3 [--pcm] [--uke-atten CENTIBELS]
"""
import glob, io, json, math, re, sys
import numpy as np, soundfile as sf
from sf2lib import SF2, Builder, Preset, Inst, Sample

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
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Ukulele (FreePats Ukulele, CC0): built from the recordings and the SFZ mapping.
# General MIDI has no ukulele, so it sits on program 24 in two extra banks that Score selects itself.
# ---------------------------------------------------------------------------

def read_sfz_regions(path):
    text = open(path, encoding='utf-8').read()
    regions = []
    for block in text.split('<region>')[1:]:
        d = dict(re.findall(r'(\w+)=(\S+)', block))
        if 'sample' not in d or 'body' in d['sample'] or 'chuck' in d['sample']:
            continue
        key = d.get('key')
        lo = int(d.get('lokey', key)); hi = int(d.get('hikey', key)); root = int(d.get('pitch_keycenter', key))
        regions.append(dict(lo=lo, hi=hi, root=root, tune=int(d.get('tune', 0)), sample=d['sample']))
    return sorted(regions, key=lambda r: r['lo'])

class AudioSource(SF2):
    """An SF2-like source built from audio files, so Builder.add_preset can copy it like any other font."""
    def __init__(self):
        self.presets, self.pbag, self.pgen, self.pmod = [], [], [], []
        self.insts, self.ibag, self.igen, self.imod = [], [], [], []
        self.samples = []
        self._pcm = []
        self.smpl = b''
        self.info = {}
    def add_sample(self, name, path, root, correction):
        x, rate = sf.read(path, dtype='float32')
        if x.ndim > 1: x = x.mean(axis=1)
        pcm = np.clip(np.round(x * 32767), -32768, 32767).astype('<i2').tobytes()
        start = len(self.smpl) // 2
        self.smpl += pcm
        n = len(pcm) // 2
        self.samples.append(Sample(name[:19], start, start + n, start, start + n, rate, root, correction, 0, 1))
        return len(self.samples) - 1
    def add_instrument(self, name, zones):
        """zones: list of dict(lo, hi, root, tune, coarse, sample_index)"""
        self.insts.append(Inst(name, len(self.ibag)))
        release = int(round(1200 * math.log2(0.35)))
        for z in zones:
            self.ibag.append((len(self.igen), len(self.imod)))
            gens = [(43, z['lo'] | (z['hi'] << 8)), (38, release), (54, 0), (58, z['root'])]
            if z.get('tune'): gens.append((52, z['tune']))
            if z.get('coarse'): gens.append((51, z['coarse']))
            if z.get('attenuation'): gens.append((48, z['attenuation']))
            gens.append((53, z['sample_index']))
            self.igen.extend(gens)
        return len(self.insts) - 1
    def add_preset_for(self, name, bank, program, inst_index):
        self.presets.append(Preset(name, program, bank, len(self.pbag), 0, 0, 0))
        self.pbag.append((len(self.pgen), len(self.pmod)))
        self.pgen.append((41, inst_index))
    def close(self):
        self.insts.append(Inst('EOI', len(self.ibag)))
        self.ibag.append((len(self.igen), len(self.imod)))
        self.presets.append(Preset('EOP', 0, 0, len(self.pbag), 0, 0, 0))
        self.pbag.append((len(self.pgen), len(self.pmod)))
        self.samples.append(Sample('EOS', 0, 0, 0, 0, 0, 0, 0, 0, 0))

UKE_DIR = 'ukulele1/'   # the FreePats Ukulele release, unpacked (README.txt, Ukulele 20260811.sfz, samples/)
UKE_GAIN_CB = int(sys.argv[sys.argv.index('--uke-atten') + 1]) if '--uke-atten' in sys.argv else 0
uke_regions = read_sfz_regions(UKE_DIR + 'Ukulele 20260811.sfz')
UK = AudioSource()
for r in uke_regions:
    r['index'] = UK.add_sample('Uke ' + r['sample'].split('/')[-1].split('.')[0], UKE_DIR + r['sample'], r['root'], 0)
# true pitch ukulele: the lowest and highest regions stretch to the ends of the keyboard
true_zones = []
for i, r in enumerate(uke_regions):
    lo = 0 if i == 0 else r['lo']
    hi = 127 if i == len(uke_regions) - 1 else r['hi']
    true_zones.append(dict(lo=lo, hi=hi, root=r['root'], tune=r['tune'], sample_index=r['index'], attenuation=UKE_GAIN_CB))
uke_true = UK.add_instrument('Ukulele', true_zones)
# ukulele for guitar parts: notes below C4 move up by whole octaves into the ukulele's range
folded = []
for r in uke_regions:
    lo, hi = max(r['lo'], 60), (127 if r is uke_regions[-1] else r['hi'])
    if lo <= hi:
        folded.append(dict(lo=lo, hi=hi, root=r['root'], tune=r['tune'], sample_index=r['index'], attenuation=UKE_GAIN_CB))
for octaves in (1, 2, 3, 4):
    band_lo, band_hi = 60 - 12 * octaves, 59 - 12 * (octaves - 1)
    for r in uke_regions:
        lo, hi = max(r['lo'] - 12 * octaves, band_lo), min(r['hi'] - 12 * octaves, band_hi)
        if r is uke_regions[0]:
            lo = band_lo
        if lo > hi:
            continue
        folded.append(dict(lo=lo, hi=hi, root=r['root'] - 12 * octaves, tune=r['tune'], sample_index=r['index'], attenuation=UKE_GAIN_CB))
folded.sort(key=lambda z: z['lo'])
uke_folded = UK.add_instrument('Ukulele folded', folded)
UK.add_preset_for('Ukulele', 8, 24, uke_true)
UK.add_preset_for('Ukulele (guitar parts)', 9, 24, uke_folded)
UK.close()
b.quality[id(UK)] = 0.4

manifest = []
for program in range(128):
    if program == 27:
        b.add_preset(FS, 0, bank=0, program=27, name='Clean Electric Guitar', attenuation_cb=70); src = 'FreePats FSBS clean (CC0)'
    elif program in MS:
        m = MS[program]; b.add_preset(m, m.find(0, program)); src = 'MuseScore_General (MIT)'
    else:
        b.add_preset(GU, GU.find(0, program)); src = 'GeneralUser GS'
    manifest.append((0, program, b.phdr[-1][0], src))

b.add_preset(UK, 0); manifest.append((8, 24, 'Ukulele', 'FreePats ukulele1 (CC0)'))
b.add_preset(UK, 1); manifest.append((9, 24, 'Ukulele (guitar parts)', 'FreePats ukulele1 (CC0)'))
b.add_preset(MS_DRUMS, MS_DRUMS.find(128, 0)); manifest.append((128, 0, 'Standard', 'MuseScore_General (MIT)'))
for i, p in enumerate(GU.presets[:-1]):
    if p.bank == 128 and p.program != 0:
        b.add_preset(GU, i); manifest.append((128, p.program, p.name, 'GeneralUser GS'))

by = {}
for (sid, si, so, eo), ni in b._sample_map.items():
    h = b.shdr[ni]; n = (h[2]-h[1]) * (1 if h[9] & 0x10 else 2)
    label = 'FSBS' if sid == id(FS) else ('GU' if sid == id(GU) else ('UKE' if sid == id(UK) else 'MS'))
    by[label] = by.get(label, 0) + n
print({k: round(v/1048576, 2) for k, v in by.items()})
size = b.write(OUT, name='Score sound bank 1.2',
               comment='Assembled for Score (github.com/rohittabs/score) from GeneralUser GS 2.0.3 by S. Christian Collins, '
                       'MuseScore_General 0.2 (FluidR3 by Frank Wen, MIT), FreePats FSBS Electric Guitar Clean (CC0) and FreePats Ukulele (CC0). See LICENSE files.',
               copyright_='See bundled licence files: GeneralUser GS License v2.0, MIT (MuseScore_General / FluidR3), CC0 (FreePats)')
json.dump(manifest, open(OUT + '.json', 'w'), indent=0)
print(f'{OUT}: {size/1048576:.2f} MB, presets={len(b.phdr)}, instruments={len(b.inst)}, samples={len(b.shdr)} (ogg {b.stats["ogg"]}, pcm {b.stats["pcm"]})')
