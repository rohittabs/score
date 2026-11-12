"""Minimal SoundFont 2 reader / writer used to analyse and assemble the Score sound bank.

Only what is needed: read every hydra table and the 16-bit sample pool, copy chosen presets
(with their instruments and samples) from several source files into a new file.
"""
import struct
from collections import namedtuple

GEN_INSTRUMENT = 41
GEN_SAMPLE_ID = 53
GEN_KEYRANGE = 43
GEN_VELRANGE = 44
GEN_SAMPLEMODES = 54
GEN_ROOTKEY = 58

Preset = namedtuple('Preset', 'name program bank bag_ndx library genre morph')
Inst = namedtuple('Inst', 'name bag_ndx')
Sample = namedtuple('Sample', 'name start end loop_start loop_end rate pitch correction link type')


def _chunks(data, start, end):
    pos = start
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        size = struct.unpack_from('<I', data, pos + 4)[0]
        yield cid, pos + 8, size
        pos += 8 + size + (size & 1)


def _name(b):
    return b.split(b'\0')[0].decode('latin-1').strip()


class SF2:
    def __init__(self, path):
        self.path = path
        with open(path, 'rb') as f:
            data = f.read()
        assert data[:4] == b'RIFF' and data[8:12] == b'sfbk', 'not a soundfont'
        self.info = {}
        self.smpl = b''
        raw = {}
        for cid, off, size in _chunks(data, 12, len(data)):
            if cid != b'LIST':
                continue
            kind = data[off:off + 4]
            for sid, soff, ssize in _chunks(data, off + 4, off + size):
                if kind == b'INFO':
                    self.info[sid.decode()] = data[soff:soff + ssize]
                elif kind == b'sdta' and sid == b'smpl':
                    self.smpl = data[soff:soff + ssize]
                elif kind == b'pdta':
                    raw[sid.decode()] = data[soff:soff + ssize]
        self.presets = [Preset(_name(r[0]), *r[1:]) for r in struct.iter_unpack('<20sHHHIII', raw['phdr'])]
        self.pbag = list(struct.iter_unpack('<HH', raw['pbag']))
        self.pmod = list(struct.iter_unpack('<HHhHH', raw['pmod']))
        self.pgen = list(struct.iter_unpack('<Hh', raw['pgen']))
        self.insts = [Inst(_name(r[0]), r[1]) for r in struct.iter_unpack('<20sH', raw['inst'])]
        self.ibag = list(struct.iter_unpack('<HH', raw['ibag']))
        self.imod = list(struct.iter_unpack('<HHhHH', raw['imod']))
        self.igen = list(struct.iter_unpack('<Hh', raw['igen']))
        self.samples = [Sample(_name(r[0]), *r[1:]) for r in struct.iter_unpack('<20sIIIIIBbHH', raw['shdr'])]

    # ---- navigation helpers -------------------------------------------------
    def preset_zones(self, pi):
        """List of (gens, mods) for each zone of preset index pi."""
        p, nxt = self.presets[pi], self.presets[pi + 1]
        zones = []
        for b in range(p.bag_ndx, nxt.bag_ndx):
            g0, m0 = self.pbag[b]
            g1, m1 = self.pbag[b + 1]
            zones.append((self.pgen[g0:g1], self.pmod[m0:m1]))
        return zones

    def inst_zones(self, ii):
        i, nxt = self.insts[ii], self.insts[ii + 1]
        zones = []
        for b in range(i.bag_ndx, nxt.bag_ndx):
            g0, m0 = self.ibag[b]
            g1, m1 = self.ibag[b + 1]
            zones.append((self.igen[g0:g1], self.imod[m0:m1]))
        return zones

    def sample_payload(self, si):
        """('ogg', bytes) for an SF3 compressed sample, otherwise ('pcm', 16-bit little endian bytes)."""
        s = self.samples[si]
        if s.type & 0x10:
            return 'ogg', self.smpl[s.start:s.end]
        return 'pcm', self.smpl[s.start * 2:s.end * 2]

    def sample_loop(self, si):
        """Loop points relative to the start of the sample, in frames."""
        s = self.samples[si]
        if s.type & 0x10:
            return s.loop_start, s.loop_end
        return s.loop_start - s.start, s.loop_end - s.start

    def find(self, bank, program):
        for i, p in enumerate(self.presets[:-1]):
            if p.bank == bank and p.program == program:
                return i
        return None

    def preset_instruments(self, pi):
        out = []
        for gens, _ in self.preset_zones(pi):
            for op, val in gens:
                if op == GEN_INSTRUMENT:
                    out.append(val & 0xFFFF)
        return out

    def describe(self, pi):
        """Statistics that correlate with realism: sampled keys, velocity layers, sample seconds, looping."""
        p = self.presets[pi]
        sample_ids, roots, vel_ranges, looped, unlooped = set(), set(), set(), 0, 0
        for ii in self.preset_instruments(pi):
            glob = {}
            for zi, (gens, _) in enumerate(self.inst_zones(ii)):
                d = dict(gens)
                if GEN_SAMPLE_ID not in d:
                    if zi == 0:
                        glob = d
                    continue
                d = {**glob, **d}
                sid = d[GEN_SAMPLE_ID] & 0xFFFF
                sample_ids.add(sid)
                s = self.samples[sid]
                root = d.get(GEN_ROOTKEY, -1)
                roots.add(root if root >= 0 else s.pitch)
                if GEN_VELRANGE in d:
                    v = d[GEN_VELRANGE] & 0xFFFF
                    vel_ranges.add((v & 0xFF, v >> 8))
                if d.get(GEN_SAMPLEMODES, 0) & 1:
                    looped += 1
                else:
                    unlooped += 1
        secs = sum((self.samples[s].end - self.samples[s].start) / max(1, self.samples[s].rate) for s in sample_ids)
        nbytes = sum((self.samples[s].end - self.samples[s].start) * 2 for s in sample_ids)
        return dict(name=p.name, bank=p.bank, program=p.program, samples=len(sample_ids), roots=len(roots),
                    vel_layers=max(1, len(vel_ranges)), looped=looped, unlooped=unlooped,
                    seconds=round(secs, 1), avg_sec=round(secs / max(1, len(sample_ids)), 2), mb=round(nbytes / 1048576, 2))


class Builder:
    """Assemble a new SF2 from presets of several source fonts."""

    def __init__(self):
        self.phdr, self.pbag, self.pgen, self.pmod = [], [], [], []
        self.inst, self.ibag, self.igen, self.imod = [], [], [], []
        self.shdr = []
        self.smpl = bytearray()
        self._inst_map = {}    # (id(src), inst index) -> new index
        self._sample_map = {}  # (id(src), sample index) -> new index
        self.encoder = None    # callable(pcm16 bytes, rate, quality) -> ogg bytes
        self.min_compress = 8192
        self.quality = {}      # id(src) -> encoder quality
        self.stats = {'ogg': 0, 'pcm': 0}
        self.attenuation_scale = 1.0

    def quality_for(self, src):
        return self.quality.get(id(src), 0.3)

    def _add_sample(self, src, si, start_off=0, end_off=0):
        """Copy one sample. start_off / end_off (frames) bake SoundFont address offsets into the data."""
        key = (id(src), si, start_off, end_off)
        if key in self._sample_map:
            return self._sample_map[key]
        s = src.samples[si]
        kind, payload = src.sample_payload(si)
        loop_start, loop_end = src.sample_loop(si)
        if kind == 'pcm' and (start_off or end_off):
            total = len(payload) // 2
            lo, hi = max(0, start_off), min(total, total + end_off)
            if hi - lo >= 16:
                payload = payload[lo * 2:hi * 2]
                loop_start, loop_end = max(0, loop_start - lo), max(0, min(loop_end - lo, hi - lo))
        frames = len(payload) // 2
        if kind == 'pcm' and self.encoder and frames >= self.min_compress:
            encoded = self.encoder(payload, s.rate, self.quality_for(src))
            if encoded is not None and len(encoded) < len(payload) * 0.8:
                kind, payload = 'ogg', encoded
        new_index = len(self.shdr)
        self._sample_map[key] = new_index
        if len(self.smpl) & 1:
            self.smpl += b'\0'
        if kind == 'ogg':
            start = len(self.smpl)
            self.smpl += payload
            self.shdr.append([s.name, start, start + len(payload), loop_start, loop_end, s.rate, s.pitch, s.correction, 0, 0x11])
            self.stats['ogg'] += 1
        else:
            start = len(self.smpl) // 2
            self.smpl += payload
            self.smpl += b'\0' * (46 * 2)  # the spec asks for 46 zero frames after every sample
            self.shdr.append([s.name, start, start + frames, start + loop_start, start + loop_end, s.rate, s.pitch, s.correction, 0, 1])
            self.stats['pcm'] += 1
        return new_index

    def _add_inst(self, src, ii):
        key = (id(src), ii)
        if key in self._inst_map:
            return self._inst_map[key]
        new_index = len(self.inst)
        self._inst_map[key] = new_index
        self.inst.append((src.insts[ii].name, len(self.ibag)))
        OFFSET_OPS = (0, 1, 4, 12)  # start / end address offsets, fine and coarse
        zones = src.inst_zones(ii)
        global_gens = dict(zones[0][0]) if zones and GEN_SAMPLE_ID not in dict(zones[0][0]) else {}
        for gens, mods in zones:
            self.ibag.append((len(self.igen), len(self.imod)))
            d = dict(gens)
            eff = {op: d.get(op, global_gens.get(op, 0)) for op in OFFSET_OPS}
            start_off = eff[0] + 32768 * eff[4]
            end_off = eff[1] + 32768 * eff[12]
            for op, val in gens:
                if op in OFFSET_OPS:
                    continue  # baked into the sample data, compressed samples cannot be offset by the player
                if op == GEN_SAMPLE_ID:
                    val = self._add_sample(src, val & 0xFFFF, start_off, end_off)
                    val = val - 65536 if val > 32767 else val
                elif op == 48:
                    val = int(round(val * self.attenuation_scale))
                self.igen.append((op, val))
            self.imod.extend(mods)
        return new_index

    def add_preset(self, src, pi, bank=None, program=None, name=None, attenuation_cb=0, extra=None):
        """attenuation_cb is added to every zone of the preset (positive = quieter). extra: {generator: value} added the same way."""
        p = src.presets[pi]
        self.phdr.append((name or p.name, p.program if program is None else program,
                          p.bank if bank is None else bank, len(self.pbag)))
        add = dict(extra or {})
        if attenuation_cb:
            add[48] = add.get(48, 0) + attenuation_cb
        for gens, mods in src.preset_zones(pi):
            self.pbag.append((len(self.pgen), len(self.pmod)))
            d = dict(gens)
            is_layer = GEN_INSTRUMENT in d
            pending = dict(add) if is_layer else {}
            for op, val in gens:
                if op == GEN_INSTRUMENT:
                    for aop, aval in pending.items():   # generators must come before the instrument reference
                        self.pgen.append((aop, aval))
                    pending = {}
                    val = self._add_inst(src, val & 0xFFFF)
                    val = val - 65536 if val > 32767 else val
                else:
                    if op == 48:
                        val = int(round(val * self.attenuation_scale))
                    if op in pending:
                        val = val + pending.pop(op)
                self.pgen.append((op, val))
            self.pmod.extend(mods)

    def write(self, path, name='Score', comment='', copyright_=''):
        def z(text, size):
            return text.encode('latin-1', 'replace')[:size - 1].ljust(size, b'\0')

        def chunk(cid, payload):
            payload = bytes(payload)
            return cid + struct.pack('<I', len(payload)) + payload + (b'\0' if len(payload) & 1 else b'')

        def zstr(text):
            b = text.encode('latin-1', 'replace') + b'\0'
            return b + (b'\0' if len(b) & 1 else b'')

        info = chunk(b'ifil', struct.pack('<HH', 3, 1)) + chunk(b'isng', zstr('EMU8000')) + chunk(b'INAM', zstr(name))
        if copyright_:
            info += chunk(b'ICOP', zstr(copyright_))
        if comment:
            info += chunk(b'ICMT', zstr(comment))
        info += chunk(b'ISFT', zstr('Score sound bank builder'))

        phdr = b''.join(struct.pack('<20sHHHIII', z(n, 20), prog, bank, bag, 0, 0, 0) for n, prog, bank, bag in self.phdr)
        phdr += struct.pack('<20sHHHIII', z('EOP', 20), 0, 0, len(self.pbag), 0, 0, 0)
        pbag = b''.join(struct.pack('<HH', g, m) for g, m in self.pbag) + struct.pack('<HH', len(self.pgen), len(self.pmod))
        pmod = b''.join(struct.pack('<HHhHH', *m) for m in self.pmod) + struct.pack('<HHhHH', 0, 0, 0, 0, 0)
        pgen = b''.join(struct.pack('<Hh', op, v) for op, v in self.pgen) + struct.pack('<Hh', 0, 0)
        inst = b''.join(struct.pack('<20sH', z(n, 20), bag) for n, bag in self.inst) + struct.pack('<20sH', z('EOI', 20), len(self.ibag))
        ibag = b''.join(struct.pack('<HH', g, m) for g, m in self.ibag) + struct.pack('<HH', len(self.igen), len(self.imod))
        imod = b''.join(struct.pack('<HHhHH', *m) for m in self.imod) + struct.pack('<HHhHH', 0, 0, 0, 0, 0)
        igen = b''.join(struct.pack('<Hh', op, v) for op, v in self.igen) + struct.pack('<Hh', 0, 0)
        shdr = b''.join(struct.pack('<20sIIIIIBbHH', z(s[0], 20), *s[1:10]) for s in self.shdr)
        shdr += struct.pack('<20sIIIIIBbHH', z('EOS', 20), 0, 0, 0, 0, 0, 0, 0, 0, 0)

        pdta = (chunk(b'phdr', phdr) + chunk(b'pbag', pbag) + chunk(b'pmod', pmod) + chunk(b'pgen', pgen) +
                chunk(b'inst', inst) + chunk(b'ibag', ibag) + chunk(b'imod', imod) + chunk(b'igen', igen) + chunk(b'shdr', shdr))
        if len(self.smpl) & 1:
            self.smpl += b'\0'  # some readers (alphaTab among them) do not skip RIFF pad bytes, so keep the pool even
        body = (b'sfbk' + chunk(b'LIST', b'INFO' + info) + chunk(b'LIST', b'sdta' + chunk(b'smpl', self.smpl)) +
                chunk(b'LIST', b'pdta' + pdta))
        with open(path, 'wb') as f:
            f.write(b'RIFF' + struct.pack('<I', len(body)) + body)
        return len(body) + 8
