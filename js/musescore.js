/* Score: MuseScore reader
   Opens MuseScore files (.mscz and .mscx, saved by MuseScore 3, 4 or later) by translating them into
   MusicXML, which alphaTab then reads like any other MusicXML file. Everything happens in the browser.

   The translation follows what MuseScore's own MusicXML export writes, because alphaTab's MusicXML
   reader is tuned for that output.
*/
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------------
     Zip (.mscz files are zip archives)
  --------------------------------------------------------------------- */
  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unpack .mscz files. Please update it, or export MusicXML from MuseScore.');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function zipEntries(bytes) {
    // Find the end of central directory record (it is in the last 64 KB plus 22 bytes)
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This .mscz file is damaged (no zip directory).');
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const entries = [];
    const decoder = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (u32(bytes, p) !== 0x02014b50) break;
      const method = u16(bytes, p + 10);
      const compressedSize = u32(bytes, p + 20);
      const nameLength = u16(bytes, p + 28);
      const extraLength = u16(bytes, p + 30);
      const commentLength = u16(bytes, p + 32);
      const localOffset = u32(bytes, p + 42);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
      entries.push({ name, method, compressedSize, localOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function zipRead(bytes, entry) {
    const p = entry.localOffset;
    if (u32(bytes, p) !== 0x04034b50) throw new Error('This .mscz file is damaged.');
    const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new Error('This .mscz file uses an unknown compression.');
  }

  async function extractMscx(bytes) {
    const entries = zipEntries(bytes);
    let target = null;
    const container = entries.find((e) => e.name === 'META-INF/container.xml');
    if (container) {
      const xml = new TextDecoder('utf-8').decode(await zipRead(bytes, container));
      const m = /full-path="([^"]+\.mscx)"/i.exec(xml);
      if (m) target = entries.find((e) => e.name === m[1]);
    }
    if (!target) target = entries.find((e) => /\.mscx$/i.test(e.name) && e.name.indexOf('/') < 0);
    if (!target) target = entries.find((e) => /\.mscx$/i.test(e.name) && !/^Excerpts\//i.test(e.name));
    if (!target) throw new Error('No score was found inside this .mscz file.');
    return new TextDecoder('utf-8').decode(await zipRead(bytes, target));
  }

  /* ---------------------------------------------------------------------
     Small DOM helpers (work with the browser DOMParser and with xmldom in tests)
  --------------------------------------------------------------------- */
  function kids(el, name) {
    const out = [];
    if (!el) return out;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && (!name || n.nodeName === name)) out.push(n);
    }
    return out;
  }
  function kid(el, name) {
    if (!el) return null;
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) return n;
    return null;
  }
  function txt(el, name, fallback) {
    const k = name ? kid(el, name) : el;
    if (!k) return fallback === undefined ? null : fallback;
    return k.textContent;
  }
  function num(el, name, fallback) {
    const t = txt(el, name, null);
    if (t === null || t.trim() === '') return fallback;
    const v = Number(t.trim());
    return Number.isFinite(v) ? v : fallback;
  }
  function has(el, name) { return !!kid(el, name); }

  /* ---------------------------------------------------------------------
     Music helpers
  --------------------------------------------------------------------- */
  const DURATION_TICKS = { // in quarter notes
    long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125,
    '64th': 0.0625, '128th': 0.03125, '256th': 0.015625, '512th': 0.0078125, '1024th': 0.00390625,
  };
  const MXL_TYPE = { long: 'long', breve: 'breve', whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth',
    '16th': '16th', '32nd': '32nd', '64th': '64th', '128th': '128th', '256th': '256th', '512th': '512th', '1024th': '1024th' };
  const LETTERS_FIFTHS = 'FCGDAEB';
  const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const STEPS = 'CDEFGAB';

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; }
  function frac(n, d) { const g = gcd(n, d); return { n: n / g, d: d / g }; }
  function parseFraction(text) {
    if (!text) return null;
    const m = /(-?\d+)\s*\/\s*(\d+)/.exec(text);
    if (!m) return null;
    return frac(Number(m[1]), Number(m[2]));
  }

  function tpcSpelling(tpc) {
    const i = ((tpc - 13) % 7 + 7) % 7;
    return { step: LETTERS_FIFTHS[i], alter: Math.floor((tpc - 13) / 7) };
  }
  function defaultTpc(pitch) {
    // sharps for black keys, like MuseScore does without a key context
    return [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19][((pitch % 12) + 12) % 12];
  }
  function spell(pitch, tpc) {
    if (typeof tpc !== 'number' || !Number.isFinite(tpc)) tpc = defaultTpc(pitch);
    const s = tpcSpelling(tpc);
    let octave = Math.floor((pitch - s.alter - PITCH_CLASS[s.step]) / 12) - 1;
    // guard against tpc values that do not belong to this pitch
    const check = (octave + 1) * 12 + PITCH_CLASS[s.step] + s.alter;
    if (check !== pitch) return spell(pitch, defaultTpc(pitch));
    return { step: s.step, alter: s.alter, octave };
  }
  function tuningPitch(pitch) {
    const s = spell(pitch, defaultTpc(pitch));
    return s;
  }

  // The interval of a transposing instrument in "fifths": the value t with 7t = chromatic (mod 12)
  // and 4t = diatonic (mod 7). Written tpc = concert tpc - t.
  function transpositionFifths(chromatic, diatonic) {
    for (let t = -11; t <= 11; t++) {
      if (((7 * t - chromatic) % 12 + 12) % 12 === 0 && ((4 * t - diatonic) % 7 + 7) % 7 === 0) return t;
    }
    return 0;
  }

  const CLEFS = {
    G: ['G', 2, 0], G8vb: ['G', 2, -1], G8va: ['G', 2, 1], G15mb: ['G', 2, -2], G15ma: ['G', 2, 2],
    G8vbo: ['G', 2, -1], G8vbp: ['G', 2, -1], G1: ['G', 1, 0],
    F: ['F', 4, 0], F8vb: ['F', 4, -1], F8va: ['F', 4, 1], F15mb: ['F', 4, -2], F15ma: ['F', 4, 2],
    F_B: ['F', 3, 0], F_C: ['F', 5, 0], F_F18C: ['F', 4, 0], F_19C: ['F', 4, 0],
    C1: ['C', 1, 0], C2: ['C', 2, 0], C3: ['C', 3, 0], C4: ['C', 4, 0], C5: ['C', 5, 0], C4_8vb: ['C', 4, -1],
    C_19C: ['C', 3, 0], C1_F18C: ['C', 1, 0], C3_F18C: ['C', 3, 0], C4_F18C: ['C', 4, 0], C1_F20C: ['C', 1, 0], C3_F20C: ['C', 3, 0], C4_F20C: ['C', 4, 0],
    PERC: ['percussion', 0, 0], PERC2: ['percussion', 0, 0],
    TAB: ['TAB', 5, 0], TAB4: ['TAB', 5, 0], TAB2: ['TAB', 5, 0], TAB_SERIF: ['TAB', 5, 0], TAB4_SERIF: ['TAB', 5, 0],
  };
  function clefInfo(name) {
    if (!name) return null;
    name = String(name).trim();
    if (CLEFS[name]) return CLEFS[name];
    // MuseScore 2 era numeric clef ids
    const numeric = { 0: 'G', 1: 'G8va', 2: 'G15ma', 3: 'G8vb', 4: 'F', 5: 'F8vb', 6: 'F15mb', 7: 'F_B', 8: 'F_C', 9: 'C1', 10: 'C2', 11: 'C3', 12: 'C4', 13: 'TAB', 14: 'PERC' };
    if (/^\d+$/.test(name) && numeric[name]) return CLEFS[numeric[name]];
    if (/^TAB/.test(name)) return CLEFS.TAB;
    if (/^PERC/.test(name)) return CLEFS.PERC;
    if (/^G/.test(name)) return CLEFS.G;
    if (/^F/.test(name)) return CLEFS.F;
    if (/^C/.test(name)) return CLEFS.C3;
    return null;
  }

  const DYNAMIC_VELOCITY = { pppppp: 1, ppppp: 5, pppp: 10, ppp: 16, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 126, ffff: 127, fffff: 127, ffffff: 127,
    fp: 96, pf: 49, sf: 112, sfz: 112, sff: 126, sffz: 126, sfp: 112, sfpp: 112, rfz: 112, rf: 112, fz: 112, m: 96, r: 112, s: 112, z: 80, n: 1 };
  const MXL_DYNAMICS = new Set(['p', 'pp', 'ppp', 'pppp', 'ppppp', 'pppppp', 'f', 'ff', 'fff', 'ffff', 'fffff', 'ffffff', 'mp', 'mf', 'sf', 'sfp', 'sfpp', 'fp', 'rf', 'rfz', 'sfz', 'sffz', 'fz', 'n', 'pf', 'sfzp']);

  const HEADS = { cross: 'x', xcircle: 'circle-x', 'circle-x': 'circle-x', withx: 'x', diamond: 'diamond', 'diamond-old': 'diamond', triangle: 'triangle', 'triangle-up': 'triangle',
    'triangle-down': 'inverted triangle', slash: 'slash', 'slashed1': 'slashed', 'slashed2': 'back slashed', 'circled': 'circled', 'large-circled': 'circled', 'plus': 'cross',
    'do': 'do', 're': 're', 'mi': 'mi', 'fa': 'fa', 'sol': 'so', 'la': 'la', 'ti': 'ti' };

  // MuseScore's default drum set (used when a drum part does not list its own drums): pitch -> [line, head]
  const DEFAULT_DRUMS = {
    35: [7, 'normal'], 36: [7, 'normal'], 37: [3, 'cross'], 38: [3, 'normal'], 39: [3, 'slash'], 40: [3, 'normal'], 41: [5, 'normal'], 42: [-1, 'cross'],
    43: [5, 'normal'], 44: [9, 'cross'], 45: [2, 'normal'], 46: [-1, 'xcircle'], 47: [1, 'normal'], 48: [0, 'normal'], 49: [-2, 'cross'], 50: [0, 'normal'],
    51: [0, 'cross'], 52: [-3, 'cross'], 53: [0, 'diamond'], 54: [2, 'diamond'], 55: [-3, 'cross'], 56: [1, 'triangle'], 57: [-3, 'cross'], 58: [-1, 'diamond'],
    59: [2, 'cross'], 60: [8, 'normal'], 61: [9, 'normal'], 62: [6, 'cross'], 63: [6, 'normal'], 64: [7, 'normal'], 65: [5, 'normal'], 66: [6, 'normal'],
    67: [-1, 'triangle'], 68: [0, 'triangle'], 69: [2, 'cross'], 70: [1, 'cross'], 75: [3, 'triangle'], 76: [1, 'diamond'], 77: [2, 'diamond'], 81: [-1, 'triangle'],
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function cleanText(el) {
    // MuseScore rich text keeps <sym> names inside text; drop them, keep the words
    if (!el) return '';
    let out = '';
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          if (c.nodeName === 'sym') {
            const s = c.textContent;
            if (/^metNoteQuarter/.test(s)) out += '♩';
            else if (/^metNoteHalf/.test(s)) out += '𝅗𝅥';
            else if (/^metNote8th/.test(s)) out += '♪';
            else if (/^metAugmentationDot/.test(s)) out += '.';
          } else if (c.nodeName === 'br') out += '\n';
          else walk(c);
        }
      }
    };
    walk(el);
    return out.replace(/\s+\n/g, '\n').trim();
  }

  /* ---------------------------------------------------------------------
     The translator
  --------------------------------------------------------------------- */
  function mscxToMusicXml(xmlText, parseXml) {
    const doc = parseXml(xmlText);
    const museScore = doc.documentElement;
    if (!museScore || museScore.nodeName !== 'museScore') throw new Error('This is not a MuseScore file.');
    const version = parseFloat(museScore.getAttribute('version') || '0');
    if (version < 3) {
      throw new Error('This file was saved by MuseScore ' + (version || 2) + '. Open it in MuseScore 3 or 4 and save it again, or export it as MusicXML.');
    }
    const score = kid(museScore, 'Score');
    if (!score) throw new Error('This MuseScore file has no score in it.');

    const division = num(score, 'Division', 480);
    const DIV = division; // MusicXML divisions per quarter

    /* ---- meta ---- */
    const meta = {};
    for (const t of kids(score, 'metaTag')) meta[t.getAttribute('name')] = (t.textContent || '').trim();

    /* ---- staff contents (direct children of Score only; MuseScore 3 nests parts as <Score> inside) ---- */
    const staffContents = kids(score, 'Staff');
    const staffContentById = new Map();
    staffContents.forEach((s, i) => staffContentById.set(Number(s.getAttribute('id') || i + 1), s));

    /* ---- frames: titles ---- */
    const texts = { title: '', subtitle: '', composer: '', lyricist: '' };
    if (staffContents[0]) {
      for (const box of kids(staffContents[0]).filter((e) => e.nodeName === 'VBox' || e.nodeName === 'TBox')) {
        for (const t of kids(box, 'Text')) {
          const style = (txt(t, 'style', '') || '').trim().toLowerCase();
          const value = cleanText(kid(t, 'text'));
          if (!value) continue;
          if (style === 'title' && !texts.title) texts.title = value.split('\n')[0];
          else if (style === 'subtitle' && !texts.subtitle) texts.subtitle = value.split('\n')[0];
          else if (style === 'composer' && !texts.composer) texts.composer = value.replace(/\n/g, ', ');
          else if ((style === 'lyricist' || style === 'poet') && !texts.lyricist) texts.lyricist = value.replace(/\n/g, ', ');
        }
        if (box.nodeName === 'VBox') {
          // titles are in the first frame; stop at the first measure
        }
      }
    }
    const untitled = /^(untitled score|partitura senza titolo|sans titre)$/i;
    let title = texts.title || meta.workTitle || meta.movementTitle || '';
    if (untitled.test(title)) title = texts.title || '';
    const subtitle = texts.subtitle || meta.subtitle || '';
    const composer = texts.composer || meta.composer || '';
    const lyricist = texts.lyricist || meta.lyricist || '';
    const arranger = meta.arranger || '';
    const copyright = (meta.copyright || '').replace(/\s*\n\s*/g, ' · ');

    /* ---- parts and staff definitions ---- */
    const partEls = kids(score, 'Part');
    let globalStaffIndex = 0;
    const parts = partEls.map((partEl, pi) => {
      const instrument = kid(partEl, 'Instrument');
      const staffDefs = kids(partEl, 'Staff').map((s) => {
        globalStaffIndex++;
        const id = Number(s.getAttribute('id') || globalStaffIndex);
        const typeEl = kid(s, 'StaffType');
        const group = typeEl ? (typeEl.getAttribute('group') || 'pitched') : 'pitched';
        const lines = num(typeEl, 'lines', group === 'tablature' ? 6 : 5);
        return {
          id,
          group,
          lines,
          linkedTo: num(s, 'linkedTo', null),
          clef: txt(s, 'defaultTransposingClef', null) || txt(s, 'defaultClef', null) || txt(s, 'defaultConcertClef', null),
          concertClef: txt(s, 'defaultConcertClef', null) || txt(s, 'defaultClef', null),
          invisible: num(s, 'invisible', 0) === 1,
        };
      });

      // linked staves (standard + tab of the same music) become one staff that shows both
      const groups = [];
      for (const def of staffDefs) {
        const g = def.linkedTo ? groups.find((gr) => gr.some((d) => d.id === def.linkedTo || d.linkedTo === def.id)) : null;
        if (g) g.push(def); else groups.push([def]);
      }
      const outStaves = groups.map((g) => {
        const main = g.find((d) => d.group !== 'tablature') || g[0];
        return {
          defs: g,
          main,
          hasTab: g.some((d) => d.group === 'tablature'),
          hasStandard: g.some((d) => d.group === 'pitched'),
          isPercussion: g.some((d) => d.group === 'percussion'),
          content: staffContentById.get(main.id) || staffContents[main.id - 1] || null,
        };
      });

      const longName = cleanText(kid(instrument, 'longName')) || '';
      const trackName = (txt(partEl, 'trackName', '') || '').trim() || (txt(instrument, 'trackName', '') || '').trim() || longName || ('Part ' + (pi + 1));

      // channel: the first one, or the one named "normal"
      const channels = kids(instrument, 'Channel');
      const channel = channels.find((c) => !c.getAttribute('name') || c.getAttribute('name') === 'normal' || c.getAttribute('name') === 'arco' || c.getAttribute('name') === 'open') || channels[0] || null;
      let program = 0;
      let volume = 100;
      let pan = 64;
      if (channel) {
        const pr = kid(channel, 'program');
        if (pr) program = Number(pr.getAttribute('value') || 0);
        for (const c of kids(channel, 'controller')) {
          const ctrl = Number(c.getAttribute('ctrl'));
          const value = Number(c.getAttribute('value'));
          if (ctrl === 7) volume = value;
          if (ctrl === 10) pan = value;
        }
      }

      const stringData = kid(instrument, 'StringData');
      const strings = stringData ? kids(stringData, 'string').map((s) => Number(s.textContent.trim())).filter((v) => Number.isFinite(v)) : [];
      const frets = stringData ? num(stringData, 'frets', 24) : 24;

      const drums = new Map();
      for (const d of kids(instrument, 'Drum')) {
        drums.set(Number(d.getAttribute('pitch')), {
          line: num(d, 'line', null),
          head: (txt(d, 'head', 'normal') || 'normal').trim(),
          name: (txt(d, 'name', '') || '').trim(),
        });
      }
      const instrumentId = (txt(instrument, 'instrumentId', '') || '').trim();
      const isDrum = num(instrument, 'useDrumset', 0) === 1 || drums.size > 0 || /^drum\./.test(instrumentId) ||
        outStaves.some((s) => s.isPercussion);

      const pluckedProgram = (program >= 24 && program <= 39) || (program >= 104 && program <= 107);
      const isPlucked = !isDrum && strings.length > 0 && (outStaves.some((s) => s.hasTab) || /^pluck\./.test(instrumentId) || pluckedProgram);
      let transposeChromatic = num(instrument, 'transposeChromatic', 0);
      let transposeDiatonic = num(instrument, 'transposeDiatonic', 0);
      // string tunings are stored at written pitch; tab and playback need the sounding pitch
      for (let i = 0; i < strings.length; i++) strings[i] += transposeChromatic;
      let octaveClef = 0;
      if (isPlucked && transposeChromatic !== 0 && transposeChromatic % 12 === 0) {
        // a guitar written an octave higher: keep the sound, show it with an octave clef (G8vb) like MuseScore 3 does
        octaveClef = transposeChromatic / 12;
        transposeChromatic = 0;
        transposeDiatonic = 0;
      }

      return {
        index: pi,
        id: 'P' + (pi + 1),
        name: trackName,
        abbreviation: cleanText(kid(instrument, 'shortName')) || '',
        program: Math.max(0, Math.min(127, program)),
        volume,
        pan,
        strings,
        frets,
        drums,
        isDrum,
        isPlucked,
        transposeChromatic,
        transposeDiatonic,
        octaveClef,
        tFifths: transpositionFifths(transposeChromatic, transposeDiatonic),
        outStaves,
        usedDrumPitches: new Set(),
      };
    });

    if (!parts.length) throw new Error('This MuseScore file has no instruments.');
    const staffByGlobalIndex = []; // 0-based staff index in the score -> { part, sIdx }
    for (const part of parts) {
      part.outStaves.forEach((os, sIdx) => { for (const d of os.defs) staffByGlobalIndex[d.id - 1] = { part, sIdx }; });
    }

    /* ---- measure grid, taken from the first staff ---- */
    const firstContent = parts[0].outStaves[0].content;
    if (!firstContent) throw new Error('This MuseScore file has no measures.');
    // MuseScore also stores multi-measure rests as extra layout-only measures; they duplicate real measures
    const measureEls = (content) => kids(content, 'Measure').filter((m) => !has(m, 'multiMeasureRest'));
    const masterMeasures = measureEls(firstContent);
    const measures = [];
    {
      let timeN = 4;
      let timeD = 4;
      let tick = 0;
      masterMeasures.forEach((mEl, i) => {
        // time signature changes: look in every staff's first voice
        for (const part of parts) {
          for (const os of part.outStaves) {
            const msEl = os.content ? measureEls(os.content)[i] : null;
            if (!msEl) continue;
            for (const v of kids(msEl, 'voice')) {
              const ts = kid(v, 'TimeSig');
              if (ts) {
                timeN = num(ts, 'sigN', timeN);
                timeD = num(ts, 'sigD', timeD);
              }
            }
          }
        }
        const nominal = frac(timeN, timeD);
        const len = parseFraction(mEl.getAttribute('len')) || nominal;
        const ticks = Math.round((len.n / len.d) * 4 * DIV);
        measures.push({
          index: i,
          el: mEl,
          timeN,
          timeD,
          timeSymbol: null,
          len,
          ticks,
          nominalTicks: Math.round((timeN / timeD) * 4 * DIV),
          startTick: tick,
          startRepeat: has(mEl, 'startRepeat'),
          endRepeat: has(mEl, 'endRepeat') ? Math.max(2, num(mEl, 'endRepeat', 2)) : 0,
          irregular: has(mEl, 'irregular'),
          endings: null, // { numbers: [1,2], start: bool, stop: bool, open: bool }
          barStyle: null,
          sounds: [], // direction xml at tick 0 for jumps and markers
          endSounds: [],
        });
        tick += ticks;
      });
    }
    const totalTicks = measures.length ? measures[measures.length - 1].startTick + measures[measures.length - 1].ticks : 0;

    // relative location (next/prev of spanners) -> absolute tick
    function locationTicks(locEl) {
      if (!locEl) return 0;
      const f = parseFraction(txt(locEl, 'fractions', '')) || { n: 0, d: 1 };
      return { measures: num(locEl, 'measures', 0), ticks: Math.round((f.n / f.d) * 4 * DIV) };
    }
    function resolveLocation(startMeasure, startOffset, locEl) {
      const loc = locationTicks(locEl);
      let m = startMeasure + loc.measures;
      let pos = startOffset + loc.ticks;
      if (m < 0) m = 0;
      if (m >= measures.length) return totalTicks;
      while (m < measures.length - 1 && pos >= measures[m].ticks && pos > 0) { pos -= measures[m].ticks; m++; }
      while (m > 0 && pos < 0) { m--; pos += measures[m].ticks; }
      return measures[m].startTick + Math.max(0, pos);
    }
    function measureAt(tick) {
      let lo = 0;
      let hi = measures.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measures[mid].startTick <= tick) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    /* ---- pass 1: spanners that cover ranges of notes (let ring, palm mute, voltas, wedges, vibrato) ---- */
    const ranges = []; // { part, staff, kind, start, end }
    function collectSpanners(part, sIdx, content) {
      measureEls(content).forEach((mEl, mi) => {
        if (mi >= measures.length) return;
        const voices = kids(mEl, 'voice');
        voices.forEach((vEl, vi) => {
          let pos = 0;
          let tuplets = [];
          for (const e of kids(vEl)) {
            switch (e.nodeName) {
              case 'location': {
                const l = locationTicks(e);
                pos += l.ticks;
                break;
              }
              case 'Tuplet':
                tuplets.push({ normal: num(e, 'normalNotes', 2), actual: num(e, 'actualNotes', 3) });
                break;
              case 'endTuplet':
                tuplets.pop();
                break;
              case 'Chord':
              case 'Rest':
              case 'MeasureRepeat':
              case 'RepeatMeasure': {
                if (e.nodeName === 'Chord' && isGraceChord(e)) break;
                pos += eventTicks(e, tuplets, measures[mi]);
                break;
              }
              case 'Spanner': {
                const type = e.getAttribute('type');
                const next = kid(e, 'next');
                if (!next) break;
                const start = measures[mi].startTick + pos;
                const end = resolveLocation(mi, pos, kid(next, 'location'));
                if (type === 'Volta') {
                  const v = kid(e, 'Volta');
                  const endings = (txt(v, 'endings', '') || '').split(/[\s,]+/).map(Number).filter((x) => x > 0);
                  ranges.push({ part, staff: sIdx, kind: 'volta', start, end, endings: endings.length ? endings : [1], open: num(v, 'endHookType', 1) === 0, text: (txt(v, 'beginText', '') || '').trim() });
                } else if (type === 'LetRing' || type === 'PalmMute' || type === 'Vibrato' || type === 'Ottava') {
                  const inner = kid(e, type);
                  ranges.push({ part, staff: sIdx, voice: vi, kind: type, start, end, sub: (txt(inner, 'subtype', '') || '').trim() });
                }
                break;
              }
              default:
                break;
            }
          }
        });
      });
    }

    function isGraceChord(chordEl) {
      return ['acciaccatura', 'appoggiatura', 'grace4', 'grace16', 'grace32', 'grace8after', 'grace16after', 'grace32after'].some((g) => has(chordEl, g));
    }
    function eventTicks(e, tuplets, measure) {
      const type = (txt(e, 'durationType', 'quarter') || 'quarter').trim();
      if (type === 'measure') {
        const f = parseFraction(txt(e, 'duration', '')) || measure.len;
        return Math.round((f.n / f.d) * 4 * DIV);
      }
      const base = (DURATION_TICKS[type] || 1) * DIV;
      const dots = num(e, 'dots', 0);
      let value = base * (2 - Math.pow(0.5, dots));
      for (const t of tuplets) value = value * t.normal / t.actual;
      return Math.round(value);
    }

    for (const part of parts) {
      part.outStaves.forEach((os, sIdx) => { if (os.content) collectSpanners(part, sIdx, os.content); });
    }
    const spannerMap = kid(score, 'SpannerMap');
    for (const e of kids(spannerMap)) {
      const startF = parseFraction(txt(e, 'startTick', ''));
      const lenF = parseFraction(txt(e, 'ticks', ''));
      if (!startF || !lenF) continue;
      const start = Math.round((startF.n / startF.d) * 4 * DIV);
      const end = start + Math.round((lenF.n / lenF.d) * 4 * DIV);
      const track = num(e, 'track', 0);
      const where = staffByGlobalIndex[Math.floor(track / 4)];
      if (!where) continue;
      const type = e.nodeName;
      if (type === 'Volta') {
        const endings = (txt(e, 'endings', '') || '').split(/[\s,]+/).map(Number).filter((x) => x > 0);
        ranges.push({ part: where.part, staff: where.sIdx, kind: 'volta', start, end, endings: endings.length ? endings : [1], open: num(e, 'endHookType', 1) === 0, text: (txt(e, 'beginText', '') || '').trim() });
      } else if (type === 'LetRing' || type === 'PalmMute' || type === 'Vibrato' || type === 'Ottava') {
        ranges.push({ part: where.part, staff: where.sIdx, voice: track % 4, kind: type, start, end, sub: (txt(e, 'subtype', '') || '').trim() });
      }
    }
    function rangeAt(part, sIdx, kind, tick) {
      for (const r of ranges) {
        if (r.kind === kind && r.part === part && r.staff === sIdx && tick >= r.start && tick < r.end) return r;
      }
      return null;
    }
    // ottava: MuseScore pitches are written pitches, the line shifts what is heard
    function ottavaShift(sub) {
      const map = { '8va': ['down', 8], '8vb': ['up', 8], '15ma': ['down', 15], '15mb': ['up', 15], '22ma': ['down', 22], '22mb': ['up', 22],
        0: ['down', 8], 1: ['up', 8], 2: ['down', 15], 3: ['up', 15], 4: ['down', 22], 5: ['up', 22] };
      return map[String(sub).trim()] || map['8va'];
    }
    function inRange(part, sIdx, kind, tick) {
      for (const r of ranges) {
        if (r.kind === kind && r.part === part && r.staff === sIdx && tick >= r.start && tick < r.end) return true;
      }
      return false;
    }

    // voltas (from the first part that has them) -> endings on measures
    {
      const voltas = ranges.filter((r) => r.kind === 'volta');
      const seenParts = new Set(voltas.map((v) => v.part));
      const owner = parts.find((p) => seenParts.has(p));
      for (const v of voltas.filter((x) => x.part === owner)) {
        const first = measureAt(v.start);
        let last = measureAt(Math.max(v.start, v.end - 1));
        if (last < first) last = first;
        for (let m = first; m <= last; m++) {
          measures[m].endings = { numbers: v.endings, start: m === first, stop: m === last, open: v.open, text: v.text };
        }
      }
    }

    // jumps and markers (measure level in MuseScore 4, voice level in some files)
    function jumpOrMarker(e, measure, atEnd) {
      if (e.nodeName === 'Marker') {
        const label = (txt(e, 'label', '') || '').trim();
        const text = cleanText(kid(e, 'text'));
        const lower = label.toLowerCase();
        if (lower === 'segno' || lower === 'varsegno') measure.sounds.push(`<direction placement="above"><direction-type><segno/></direction-type><sound segno="${esc(label)}"/></direction>`);
        else if (lower === 'codetta' || lower === 'coda' || lower === 'varcoda' || lower === 'codab') measure.sounds.push(`<direction placement="above"><direction-type><coda/></direction-type><sound coda="${esc(label)}"/></direction>`);
        else if (lower === 'fine') measure.endSounds.push(`<direction placement="above"><direction-type><words>${esc(text || 'Fine')}</words></direction-type><sound fine="yes"/></direction>`);
        else if (lower === 'tocoda' || lower === 'tocodasym') measure.endSounds.push(`<direction placement="above"><direction-type><words>${esc(text || 'To Coda')}</words></direction-type><sound tocoda="coda"/></direction>`);
        return;
      }
      if (e.nodeName === 'Jump') {
        const jumpTo = (txt(e, 'jumpTo', '') || '').trim().toLowerCase();
        const text = cleanText(kid(e, 'text')) || '';
        if (jumpTo === 'start') measure.endSounds.push(`<direction placement="above"><direction-type><words>${esc(text || 'D.C.')}</words></direction-type><sound dacapo="yes"/></direction>`);
        else if (jumpTo) measure.endSounds.push(`<direction placement="above"><direction-type><words>${esc(text || 'D.S.')}</words></direction-type><sound dalsegno="${esc(jumpTo)}"/></direction>`);
      }
    }
    for (const m of measures) {
      for (const e of kids(m.el)) if (e.nodeName === 'Jump' || e.nodeName === 'Marker') jumpOrMarker(e, m, true);
      for (const v of kids(m.el, 'voice')) for (const e of kids(v)) if (e.nodeName === 'Jump' || e.nodeName === 'Marker') jumpOrMarker(e, m, true);
    }

    /* ---- pass 2: events per part, staff, measure and voice ---- */
    // event: { tick (within measure), kind: 'note'|'dir'|'attr', ... }
    const slurState = new Map(); // key part:staff:voice -> open slur numbers
    let slurCounter = 0;

    function readNote(part, os, noteEl, chordCtx) {
      const pitch = num(noteEl, 'pitch', 60);
      const tpc = num(noteEl, 'tpc', null);
      const tpc2 = num(noteEl, 'tpc2', null);
      const note = {
        pitch,
        tpc,
        tpc2,
        fret: num(noteEl, 'fret', null),
        string: num(noteEl, 'string', null),
        head: (txt(noteEl, 'head', '') || '').trim(),
        ghost: num(noteEl, 'ghost', 0) === 1,
        dead: num(noteEl, 'dead', 0) === 1,
        visible: num(noteEl, 'visible', 1) !== 0,
        play: num(noteEl, 'play', 1) !== 0,
        tieStart: false,
        tieStop: false,
        bend: null,
        slideOut: false,
        slideIn: false,
        fingering: [],
      };
      for (const c of kids(noteEl)) {
        if (c.nodeName === 'Spanner') {
          const type = c.getAttribute('type');
          const isNext = has(c, 'next') || has(c, type);
          const isPrev = has(c, 'prev');
          if (type === 'Tie' || type === 'LaissezVib' || type === 'PartialTie') {
            if (isNext && type === 'Tie') note.tieStart = true;
            if (type === 'LaissezVib') note.letRing = true;
            if (isPrev) note.tieStop = true;
          } else if (type === 'GuitarBend') {
            const gb = kid(c, 'GuitarBend');
            if (gb && has(c, 'next')) note.bendStart = { type: num(gb, 'guitarBendType', 0) };
            if (isPrev) note.bendEnd = true;
          } else if (type === 'Glissando' || type === 'Slide') {
            if (has(c, 'next')) note.slideOut = true;
            if (isPrev) note.slideIn = true;
          }
        } else if (c.nodeName === 'Tie') {
          note.tieStart = true; // MuseScore 3.0: <Tie id=".."/>, ended by <endSpanner id>
          chordCtx.tieIds.add(c.getAttribute('id'));
        } else if (c.nodeName === 'endSpanner') {
          if (chordCtx.tieIds.has(c.getAttribute('id'))) note.tieStop = true;
        } else if (c.nodeName === 'Bend') {
          const points = kids(c, 'point').map((p) => ({ time: Number(p.getAttribute('time') || 0), pitch: Number(p.getAttribute('pitch') || 0) }));
          if (points.length) note.bendPoints = points;
        } else if (c.nodeName === 'Fingering') {
          const t = cleanText(kid(c, 'text'));
          if (t) note.fingering.push(t);
        }
      }
      if (part.isDrum) part.usedDrumPitches.add(pitch);
      return note;
    }

    for (const part of parts) {
      part.measures = measures.map(() => part.outStaves.map(() => ({ voices: [], attrs: [] })));
      part.outStaves.forEach((os, sIdx) => {
        const content = os.content;
        if (!content) return;
        const mEls = measureEls(content);
        let currentDynamic = null;
        const tieIds = new Set();
        let lastClef = null;
        mEls.forEach((mEl, mi) => {
          if (mi >= measures.length) return;
          const measure = measures[mi];
          const slot = part.measures[mi][sIdx];
          const voiceEls = kids(mEl, 'voice');
          // measure repeat: copy the content of the measure it repeats (as MuseScore plays it)
          voiceEls.forEach((vEl, vi) => {
            const events = [];
            let pos = 0;
            const tuplets = [];
            let pendingGrace = [];
            let pendingFermata = false;
            let pendingDirs = [];
            let measureRepeat = 0;
            for (const e of kids(vEl)) {
              switch (e.nodeName) {
                case 'location': {
                  pos += locationTicks(e).ticks;
                  if (pos < 0) pos = 0;
                  break;
                }
                case 'TimeSig': {
                  const sub = num(e, 'subtype', 0);
                  if (sub === 1) measure.timeSymbol = 'common';
                  else if (sub === 2) measure.timeSymbol = 'cut';
                  break;
                }
                case 'KeySig': {
                  let key = num(e, 'concertKey', null);
                  if (key === null) key = num(e, 'accidental', null);
                  if (key === null) key = num(e, 'key', null);
                  if (key === null) break;
                  const mode = (txt(e, 'mode', '') || '').trim();
                  slot.attrs.push({ tick: pos, key: { fifths: key, mode } });
                  break;
                }
                case 'Clef': {
                  const name = txt(e, 'transposingClefType', null) || txt(e, 'concertClefType', null) || txt(e, 'subtype', null);
                  const info = clefInfo(name);
                  if (info && info[0] !== 'TAB') {
                    slot.attrs.push({ tick: pos, clef: info });
                    lastClef = info;
                  }
                  break;
                }
                case 'Tempo': {
                  const qps = num(e, 'tempo', null);
                  if (qps) {
                    const bpm = Math.round(qps * 60 * 100) / 100;
                    const visible = num(e, 'visible', 1) !== 0;
                    events.push({ tick: pos, kind: 'dir', xml: `<direction placement="above"><direction-type><metronome${visible ? '' : ' print-object="no"'}><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` });
                  }
                  break;
                }
                case 'Dynamic': {
                  const sub = (txt(e, 'subtype', '') || '').trim();
                  const velocity = num(e, 'velocity', DYNAMIC_VELOCITY[sub] || 80);
                  const mark = MXL_DYNAMICS.has(sub) ? `<${sub}/>` : `<other-dynamics>${esc(sub)}</other-dynamics>`;
                  events.push({ tick: pos, kind: 'dir', xml: `<direction placement="below"><direction-type><dynamics>${mark}</dynamics></direction-type><sound dynamics="${Math.round(velocity / 0.9 * 100) / 100}"/></direction>` });
                  currentDynamic = sub;
                  break;
                }
                case 'StaffText':
                case 'SystemText':
                case 'Expression':
                case 'PlayTechAnnotation':
                case 'InstrumentChange': {
                  const t = cleanText(kid(e, 'text'));
                  if (t) events.push({ tick: pos, kind: 'dir', xml: `<direction placement="above"><direction-type><words>${esc(t)}</words></direction-type></direction>` });
                  break;
                }
                case 'RehearsalMark': {
                  const t = cleanText(kid(e, 'text'));
                  if (t) events.push({ tick: pos, kind: 'dir', xml: `<direction placement="above"><direction-type><rehearsal>${esc(t)}</rehearsal></direction-type></direction>` });
                  break;
                }
                case 'Harmony': {
                  const info = kid(e, 'harmonyInfo') || e;
                  const rootTpc = num(info, 'root', null);
                  if (rootTpc === null) break;
                  const name = (txt(info, 'name', '') || '').trim();
                  const base = num(info, 'base', null);
                  const r = tpcSpelling(rootTpc);
                  let kindText = name;
                  if (base !== null) {
                    const b = tpcSpelling(base);
                    kindText += '/' + b.step + (b.alter > 0 ? '#'.repeat(b.alter) : 'b'.repeat(-b.alter));
                  }
                  const visible = num(e, 'visible', 1) !== 0;
                  events.push({ tick: pos, kind: 'dir', order: -1, xml: `<harmony${visible ? '' : ' print-object="no"'}><root><root-step>${r.step}</root-step>${r.alter ? `<root-alter>${r.alter}</root-alter>` : ''}</root><kind text="${esc(kindText)}">${kindText ? 'none' : 'major'}</kind></harmony>` });
                  break;
                }
                case 'Fermata':
                  pendingFermata = true;
                  break;
                case 'Tuplet':
                  tuplets.push({
                    normal: num(e, 'normalNotes', 2),
                    actual: num(e, 'actualNotes', 3),
                    started: false,
                    members: [],
                  });
                  break;
                case 'endTuplet': {
                  const t = tuplets.pop();
                  if (t && t.members.length) {
                    t.members[0].tupletStart = (t.members[0].tupletStart || 0) + 1;
                    t.members[t.members.length - 1].tupletStop = (t.members[t.members.length - 1].tupletStop || 0) + 1;
                  }
                  break;
                }
                case 'MeasureRepeat':
                case 'RepeatMeasure': {
                  measureRepeat = num(e, 'subtype', 1) || 1;
                  pos += eventTicks(e, tuplets, measure);
                  break;
                }
                case 'Chord':
                case 'Rest': {
                  const isRest = e.nodeName === 'Rest';
                  const grace = !isRest && isGraceChord(e);
                  const durationType = (txt(e, 'durationType', 'quarter') || 'quarter').trim();
                  const ticks = grace ? 0 : eventTicks(e, tuplets, measure);
                  const ev = {
                    tick: pos,
                    kind: 'note',
                    rest: isRest,
                    measureRest: durationType === 'measure',
                    type: durationType === 'measure' ? null : (MXL_TYPE[durationType] || 'quarter'),
                    dots: num(e, 'dots', 0),
                    duration: ticks,
                    grace: grace ? (has(e, 'acciaccatura') ? 'slash' : 'plain') : null,
                    graceAfter: grace && /after/.test(['grace8after', 'grace16after', 'grace32after'].find((g) => has(e, g)) || ''),
                    timeMod: tuplets.length ? tuplets.reduce((acc, t) => ({ actual: acc.actual * t.actual, normal: acc.normal * t.normal }), { actual: 1, normal: 1 }) : null,
                    visible: num(e, 'visible', 1) !== 0,
                    notes: [],
                    articulations: [],
                    fermata: pendingFermata,
                    lyrics: [],
                    slurStart: [],
                    slurStop: [],
                    hopoStart: false,
                    hopoStop: false,
                    tremolo: 0,
                    arpeggio: false,
                    staff: sIdx,
                    voice: vi,
                  };
                  pendingFermata = false;
                  if (!grace) for (const t of tuplets) t.members.push(ev);
                  const chordCtx = { tieIds };
                  for (const c of kids(e)) {
                    switch (c.nodeName) {
                      case 'Note':
                        ev.notes.push(readNote(part, os, c, chordCtx));
                        break;
                      case 'Articulation': {
                        const sub = (txt(c, 'subtype', '') || '').trim();
                        if (/^fermata/i.test(sub)) ev.fermata = true;
                        else if (/Staccatissimo/i.test(sub)) ev.articulations.push('staccatissimo');
                        else if (/Staccato/i.test(sub)) ev.articulations.push('staccato');
                        else if (/Tenuto/i.test(sub)) ev.articulations.push('tenuto');
                        else if (/Marcato/i.test(sub)) ev.articulations.push('strong-accent');
                        else if (/Accent/i.test(sub)) ev.articulations.push('accent');
                        else if (/PalmMute/i.test(sub)) ev.palmMute = true;
                        else if (/LeftHandTapping|guitarLeftHandTapping/i.test(sub)) ev.tap = true;
                        break;
                      }
                      case 'Lyrics': {
                        const t = cleanText(kid(c, 'text'));
                        if (t) ev.lyrics.push({ no: num(c, 'no', 0) + 1, text: t, syllabic: (txt(c, 'syllabic', '') || '').trim() || 'single' });
                        break;
                      }
                      case 'Spanner': {
                        const type = c.getAttribute('type');
                        if (type === 'Slur') {
                          if (has(c, 'next')) ev.slurStart.push(true);
                          if (has(c, 'prev')) ev.slurStop.push(true);
                        } else if (type === 'HammerOnPullOff') {
                          if (has(c, 'next')) ev.hopoStart = true;
                          if (has(c, 'prev')) ev.hopoStop = true;
                        }
                        break;
                      }
                      case 'Tremolo':
                      case 'TremoloSingleChord': {
                        const sub = (txt(c, 'subtype', '') || '').trim();
                        const m = /r(\d+)/.exec(sub);
                        if (m) ev.tremolo = { 8: 1, 16: 2, 32: 3, 64: 4 }[m[1]] || 0;
                        break;
                      }
                      case 'Arpeggio':
                        ev.arpeggio = true;
                        break;
                      default:
                        break;
                    }
                  }
                  if (!isRest && !ev.notes.length) break;
                  if (grace) {
                    if (ev.graceAfter) {
                      // grace notes after a note: keep them in order, they belong to the previous note
                      events.push(ev);
                    } else {
                      pendingGrace.push(ev);
                    }
                    break;
                  }
                  for (const g of pendingGrace) { g.tick = pos; events.push(g); }
                  pendingGrace = [];
                  events.push(ev);
                  pos += ticks;
                  break;
                }
                case 'Spanner': {
                  // voice level spanners are handled through ranges; hairpins become wedges
                  const type = e.getAttribute('type');
                  if (type === 'Hairpin') {
                    const inner = kid(e, 'Hairpin');
                    if (has(e, 'next')) {
                      const sub = num(inner, 'subtype', 0);
                      events.push({ tick: pos, kind: 'dir', xml: `<direction placement="below"><direction-type><wedge type="${sub === 1 || sub === 3 ? 'diminuendo' : 'crescendo'}"/></direction-type></direction>` });
                    } else if (has(e, 'prev')) {
                      events.push({ tick: pos, kind: 'dir', xml: '<direction placement="below"><direction-type><wedge type="stop"/></direction-type></direction>' });
                    }
                  }
                  break;
                }
                case 'BarLine': {
                  const sub = (txt(e, 'subtype', '') || '').trim();
                  if (sub === 'double') measure.barStyle = measure.barStyle || 'light-light';
                  else if (sub === 'end') measure.barStyle = 'light-heavy';
                  else if (sub === 'dashed') measure.barStyle = measure.barStyle || 'dashed';
                  break;
                }
                default:
                  break;
              }
            }
            for (const g of pendingGrace) { g.tick = pos; events.push(g); }
            if (measureRepeat) slot.measureRepeat = measureRepeat;
            slot.voices[vi] = events;
          });
        });
      });
    }

    // Measure repeats: copy the repeated measures, so they play and render like MuseScore plays them
    for (const part of parts) {
      part.outStaves.forEach((os, sIdx) => {
        for (let mi = 0; mi < measures.length; mi++) {
          const slot = part.measures[mi][sIdx];
          if (!slot || !slot.measureRepeat) continue;
          const count = slot.measureRepeat;
          // inside a group of `count` measures each one copies the measure `count` earlier
          const source = part.measures[mi - count] ? part.measures[mi - count][sIdx] : null;
          if (!source) continue;
          slot.voices = source.voices.map((events) => (events || []).map((ev) => cloneEvent(ev)));
          slot.copied = true;
        }
      });
    }
    function cloneEvent(ev) {
      const c = Object.assign({}, ev);
      if (ev.notes) c.notes = ev.notes.map((n) => Object.assign({}, n, { tieStart: false, tieStop: false }));
      c.slurStart = []; c.slurStop = []; c.lyrics = [];
      c.hopoStart = false; c.hopoStop = false;
      return c;
    }

    // Hammer-ons and pull-offs need the next note to know which of the two they are
    for (const part of parts) {
      part.outStaves.forEach((os, sIdx) => {
        const flat = [];
        for (let mi = 0; mi < measures.length; mi++) {
          const slot = part.measures[mi][sIdx];
          if (!slot) continue;
          (slot.voices[0] || []).forEach((ev) => { if (ev.kind === 'note' && !ev.rest) flat.push(ev); });
        }
        for (let i = 0; i < flat.length - 1; i++) {
          if (flat[i].hopoStart || (flat[i].slurStart.length && part.strings.length && flat[i].notes.length === 1 && flat[i + 1].notes.length === 1 &&
            flat[i].notes[0].string !== null && flat[i].notes[0].string === flat[i + 1].notes[0].string && flat[i].notes[0].fret !== flat[i + 1].notes[0].fret && flat[i + 1].slurStop.length && !flat[i].grace)) {
            const a = flat[i].notes[0];
            const b = flat[i + 1].notes[0];
            if (!a || !b) continue;
            const kind = b.pitch >= a.pitch ? 'hammer-on' : 'pull-off';
            a.hopo = kind;
            b.hopoStop = kind;
            if (flat[i].hopoStart) { /* explicit MuseScore 4.6 hammer-on/pull-off */ }
          }
        }
        // guitar bends: the bend end note sets the size of the bend
        for (let i = 0; i < flat.length - 1; i++) {
          for (const n of flat[i].notes) {
            if (!n.bendStart) continue;
            const target = flat.slice(i + 1, i + 3).map((ev) => ev.notes.find((m) => m.bendEnd && m.string === n.string) || ev.notes.find((m) => m.bendEnd)).find(Boolean);
            if (target) {
              n.bendAlter = target.pitch - n.pitch;
              n.preBend = n.bendStart.type === 1 && flat[i].grace;
              target.bendTarget = true;
            }
          }
        }
      });
    }

    /* ---- render MusicXML ---- */
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<score-partwise version="4.0">');
    if (title) out.push(`<work><work-title>${esc(title)}</work-title></work>`);
    out.push('<identification>');
    if (composer) out.push(`<creator type="composer">${esc(composer)}</creator>`);
    if (lyricist) out.push(`<creator type="lyricist">${esc(lyricist)}</creator>`);
    if (arranger) out.push(`<creator type="arranger">${esc(arranger)}</creator>`);
    if (copyright) out.push(`<rights>${esc(copyright)}</rights>`);
    out.push('<encoding><software>Score MuseScore reader</software></encoding>');
    out.push('</identification>');
    if (subtitle) out.push(`<credit page="1"><credit-type>subtitle</credit-type><credit-words>${esc(subtitle)}</credit-words></credit>`);

    // part list with MIDI channels (drums on channel 10)
    out.push('<part-list>');
    let channel = 1;
    for (const part of parts) {
      out.push(`<score-part id="${part.id}">`);
      out.push(`<part-name>${esc(part.name)}</part-name>`);
      if (part.abbreviation) out.push(`<part-abbreviation>${esc(part.abbreviation)}</part-abbreviation>`);
      const volume = Math.round(part.volume / 127 * 10000) / 100;
      const panDeg = Math.round((part.pan - 64) / 64 * 90);
      if (part.isDrum) {
        const pitches = [...part.usedDrumPitches].sort((a, b) => a - b);
        if (!pitches.length) pitches.push(38);
        for (const p of pitches) {
          const d = part.drums.get(p);
          out.push(`<score-instrument id="${part.id}-I${p + 1}"><instrument-name>${esc((d && d.name) || 'Drum ' + p)}</instrument-name></score-instrument>`);
        }
        for (const p of pitches) {
          out.push(`<midi-instrument id="${part.id}-I${p + 1}"><midi-channel>10</midi-channel><midi-program>1</midi-program><midi-unpitched>${p + 1}</midi-unpitched><volume>${volume}</volume><pan>${panDeg}</pan></midi-instrument>`);
        }
      } else {
        if (channel === 10) channel++;
        if (channel > 16) channel = 1;
        out.push(`<score-instrument id="${part.id}-I1"><instrument-name>${esc(part.name)}</instrument-name></score-instrument>`);
        out.push(`<midi-instrument id="${part.id}-I1"><midi-channel>${channel}</midi-channel><midi-program>${part.program + 1}</midi-program><volume>${volume}</volume><pan>${panDeg}</pan></midi-instrument>`);
        channel++;
      }
      out.push('</score-part>');
    }
    out.push('</part-list>');

    for (const part of parts) {
      out.push(`<part id="${part.id}">`);
      const staffCount = part.outStaves.length;
      const voicesPerStaff = 4;
      const keyState = part.outStaves.map(() => null);
      let prevTime = null;
      measures.forEach((measure, mi) => {
        const implicit = mi === 0 && measure.ticks < measure.nominalTicks;
        out.push(`<measure number="${mi + 1}"${implicit ? ' implicit="yes"' : ''}>`);

        // left barline: forward repeat and volta start
        if (measure.startRepeat || (measure.endings && measure.endings.start)) {
          let b = '<barline location="left">';
          if (measure.startRepeat) b += '<bar-style>heavy-light</bar-style>';
          if (measure.endings && measure.endings.start) b += `<ending number="${measure.endings.numbers.join(', ')}" type="start">${esc(measure.endings.text || measure.endings.numbers.join(', ') + '.')}</ending>`;
          if (measure.startRepeat) b += '<repeat direction="forward"/>';
          b += '</barline>';
          out.push(b);
        }

        // attributes at the start of the measure
        const attr = [];
        if (mi === 0) attr.push(`<divisions>${DIV}</divisions>`);
        part.outStaves.forEach((os, sIdx) => {
          const slot = part.measures[mi][sIdx];
          const keyAttr = slot ? slot.attrs.find((a) => a.key && a.tick === 0) : null;
          if (keyAttr || (mi === 0 && sIdx === 0)) {
            const concert = keyAttr ? keyAttr.key.fifths : (keyState[sIdx] ? keyState[sIdx].fifths : 0);
            const written = concert - (part.isDrum ? 0 : part.tFifths);
            const mode = keyAttr && keyAttr.key.mode ? keyAttr.key.mode : '';
            const sig = `${written}|${mode}`;
            if (keyState[sIdx] === null || keyState[sIdx].sig !== sig || mi === 0) {
              if (staffCount === 1 || sIdx === 0 || keyState[sIdx] === null || keyState[sIdx].sig !== sig) {
                attr.push(`<key${staffCount > 1 ? ` number="${sIdx + 1}"` : ''}><fifths>${part.isDrum ? 0 : written}</fifths>${mode && mode !== 'none' ? `<mode>${esc(mode)}</mode>` : ''}</key>`);
              }
              keyState[sIdx] = { fifths: concert, sig };
            }
          }
        });
        const timeSig = `${measure.timeN}/${measure.timeD}/${measure.timeSymbol || ''}`;
        if (prevTime !== timeSig) {
          attr.push(`<time${measure.timeSymbol ? ` symbol="${measure.timeSymbol}"` : ''}><beats>${measure.timeN}</beats><beat-type>${measure.timeD}</beat-type></time>`);
          prevTime = timeSig;
        }
        if (mi === 0) {
          if (staffCount > 1) attr.push(`<staves>${staffCount}</staves>`);
          part.outStaves.forEach((os, sIdx) => {
            const nAttr = staffCount > 1 ? ` number="${sIdx + 1}"` : '';
            const slot = part.measures[0][sIdx];
            const startClef = slot ? slot.attrs.find((a) => a.clef && a.tick === 0) : null;
            let info;
            if (part.isDrum) info = CLEFS.PERC;
            else if (os.hasTab && !os.hasStandard) info = CLEFS.TAB;
            else info = (startClef && startClef.clef) || clefInfo(os.main.clef) || (part.strings.length ? CLEFS.G8vb : CLEFS.G);
            if (part.octaveClef && info[0] === 'G' && info[2] === 0) info = [info[0], info[1], part.octaveClef];
            attr.push(`<clef${nAttr}><sign>${info[0]}</sign>${info[0] !== 'percussion' && info[0] !== 'TAB' ? `<line>${info[1]}</line>` : ''}${info[2] ? `<clef-octave-change>${info[2]}</clef-octave-change>` : ''}</clef>`);
            if (part.isPlucked) {
              let sd = `<staff-details${nAttr}><staff-lines>${part.strings.length}</staff-lines>`;
              part.strings.forEach((p, i) => {
                const t = tuningPitch(p);
                sd += `<staff-tuning line="${i + 1}"><tuning-step>${t.step}</tuning-step>${t.alter ? `<tuning-alter>${t.alter}</tuning-alter>` : ''}<tuning-octave>${t.octave}</tuning-octave></staff-tuning>`;
              });
              sd += '</staff-details>';
              attr.push(sd);
            }
          });
          if (part.transposeChromatic && !part.isDrum) {
            const oct = Math.trunc(part.transposeChromatic / 12);
            const c = part.transposeChromatic - 12 * oct;
            const d = part.transposeDiatonic - 7 * oct;
            attr.push(`<transpose><diatonic>${d}</diatonic><chromatic>${c}</chromatic>${oct ? `<octave-change>${oct}</octave-change>` : ''}</transpose>`);
          }
        }
        if (attr.length) out.push(`<attributes>${attr.join('')}</attributes>`);

        // jumps and markers at the start of the measure (first part only)
        if (part === parts[0]) for (const s of measure.sounds) out.push(s);

        // content: staff by staff, voice by voice
        let cursor = 0;
        const moveTo = (tick) => {
          if (tick > cursor) out.push(`<forward><duration>${tick - cursor}</duration></forward>`);
          else if (tick < cursor) out.push(`<backup><duration>${cursor - tick}</duration></backup>`);
          cursor = tick;
        };
        part.outStaves.forEach((os, sIdx) => {
          const slot = part.measures[mi][sIdx];
          if (!slot) return;
          // mid-measure clef changes
          const clefChanges = slot.attrs.filter((a) => a.clef && a.tick > 0);
          let voiceList = slot.voices.map((v, i) => ({ events: v || [], index: i })).filter((v) => v.events.length);
          if (!voiceList.length) voiceList = [{ events: [], index: 0 }];
          voiceList.forEach(({ events, index: vi }, listIndex) => {
            const voiceNumber = sIdx * voicesPerStaff + vi + 1;
            const sorted = events.map((ev, i) => ({ ev, i })).sort((a, b) => a.ev.tick - b.ev.tick || (a.ev.order || 0) - (b.ev.order || 0) || a.i - b.i).map((x) => x.ev);
            let hasNotes = sorted.some((ev) => ev.kind === 'note');
            if (!hasNotes && vi === 0) {
              // an empty first voice still needs a measure rest so the bar has its length
              sorted.push({ tick: 0, kind: 'note', rest: true, measureRest: true, duration: measure.ticks, notes: [], visible: true, articulations: [], lyrics: [], slurStart: [], slurStop: [], dots: 0, type: null });
              hasNotes = true;
            }
            if (!hasNotes) return;
            if (listIndex > 0 || sIdx > 0) moveTo(0);
            for (const ev of sorted) {
              if (ev.kind === 'dir') {
                moveTo(ev.tick);
                let x = ev.xml;
                if (staffCount > 1 && /^<direction/.test(x)) x = x.replace(/<\/direction>$/, `<voice>${voiceNumber}</voice><staff>${sIdx + 1}</staff></direction>`);
                else if (/^<direction/.test(x)) x = x.replace(/<\/direction>$/, `<voice>${voiceNumber}</voice></direction>`);
                out.push(x);
                continue;
              }
              if (ev.kind !== 'note') continue;
              for (const cc of clefChanges) {
                if (!cc.done && cc.tick <= ev.tick && !ev.grace) {
                  moveTo(cc.tick);
                  const info = cc.clef;
                  out.push(`<attributes><clef${staffCount > 1 ? ` number="${sIdx + 1}"` : ''}><sign>${info[0]}</sign>${info[0] !== 'percussion' && info[0] !== 'TAB' ? `<line>${info[1]}</line>` : ''}${info[2] ? `<clef-octave-change>${info[2]}</clef-octave-change>` : ''}</clef></attributes>`);
                  cc.done = true;
                }
              }
              moveTo(ev.tick);
              const absTick = measure.startTick + ev.tick;
              const ott = listIndex === 0 && !part.isDrum ? rangeAt(part, sIdx, 'Ottava', absTick) : null;
              const tags = `<voice>${voiceNumber}</voice>${staffCount > 1 ? `<staff>${sIdx + 1}</staff>` : ''}`;
              if (ott && !ott.opened) {
                const [dir, size] = ottavaShift(ott.sub);
                out.push(`<direction><direction-type><octave-shift type="${dir}" size="${size}"/></direction-type>${tags}</direction>`);
                ott.opened = true;
              }
              renderEvent(out, part, os, sIdx, staffCount, voiceNumber, ev, measure);
              if (!ev.grace) cursor = ev.tick + ev.duration;
              if (ott && !ott.closed && !ev.grace && absTick + ev.duration >= ott.end) {
                out.push(`<direction><direction-type><octave-shift type="stop" size="${ottavaShift(ott.sub)[1]}"/></direction-type>${tags}</direction>`);
                ott.closed = true;
              }
            }
          });
        });

        // right barline: backward repeat, volta stop, final bar
        if (part === parts[0]) for (const s of measure.endSounds) { moveTo(measure.ticks); out.push(s); }
        const last = mi === measures.length - 1;
        if (measure.endRepeat || (measure.endings && measure.endings.stop) || measure.barStyle || last) {
          let b = '<barline location="right">';
          const style = measure.endRepeat || last ? 'light-heavy' : measure.barStyle;
          if (style) b += `<bar-style>${style}</bar-style>`;
          if (measure.endings && measure.endings.stop) b += `<ending number="${measure.endings.numbers.join(', ')}" type="${measure.endings.open ? 'discontinue' : 'stop'}"/>`;
          if (measure.endRepeat) b += `<repeat direction="backward"${measure.endRepeat > 2 ? ` times="${measure.endRepeat}"` : ''}/>`;
          b += '</barline>';
          out.push(b);
        }
        out.push('</measure>');
      });
      out.push('</part>');
    }
    out.push('</score-partwise>');
    return out.join('\n');

    /* ---- one chord or rest ---- */
    function renderEvent(out, part, os, sIdx, staffCount, voiceNumber, ev, measure) {
      const staffTag = staffCount > 1 ? `<staff>${sIdx + 1}</staff>` : '';
      const absTick = measure.startTick + ev.tick;
      if (ev.rest) {
        const printObject = ev.visible ? '' : ' print-object="no"';
        let x = `<note${printObject}>`;
        x += ev.measureRest ? '<rest measure="yes"/>' : '<rest/>';
        x += `<duration>${Math.max(1, ev.duration)}</duration><voice>${voiceNumber}</voice>`;
        if (!ev.measureRest && ev.type) x += `<type>${ev.type}</type>` + '<dot/>'.repeat(ev.dots || 0);
        if (ev.timeMod) x += `<time-modification><actual-notes>${ev.timeMod.actual}</actual-notes><normal-notes>${ev.timeMod.normal}</normal-notes></time-modification>`;
        x += staffTag;
        const notations = [];
        if (ev.tupletStart) notations.push('<tuplet type="start" bracket="yes"/>');
        if (ev.tupletStop) notations.push('<tuplet type="stop"/>');
        if (ev.fermata) notations.push('<fermata/>');
        if (notations.length) x += `<notations>${notations.join('')}</notations>`;
        x += '</note>';
        out.push(x);
        return;
      }
      const letRing = inRange(part, sIdx, 'LetRing', absTick);
      const palmMute = ev.palmMute || inRange(part, sIdx, 'PalmMute', absTick);
      const vibrato = inRange(part, sIdx, 'Vibrato', absTick);
      // lowest note first, like MuseScore writes them
      const notes = ev.notes.slice().sort((a, b) => a.pitch - b.pitch);
      notes.forEach((n, ni) => {
        const printObject = ev.visible && n.visible ? '' : ' print-object="no"';
        let x = `<note${printObject}>`;
        if (ev.grace) x += ev.grace === 'slash' ? '<grace slash="yes"/>' : '<grace/>';
        if (ni > 0) x += '<chord/>';
        if (part.isDrum) {
          const d = part.drums.get(n.pitch);
          let line = d && d.line !== null ? d.line : (DEFAULT_DRUMS[n.pitch] ? DEFAULT_DRUMS[n.pitch][0] : 3);
          const diatonic = 38 - line; // line 0 is the top line, F5
          x += `<unpitched><display-step>${STEPS[((diatonic % 7) + 7) % 7]}</display-step><display-octave>${Math.floor(diatonic / 7)}</display-octave></unpitched>`;
        } else {
          const ott = rangeAt(part, sIdx, 'Ottava', absTick);
          const ottSemitones = ott ? { 8: 12, 15: 24, 22: 36 }[ottavaShift(ott.sub)[1]] * (ottavaShift(ott.sub)[0] === 'down' ? 1 : -1) : 0;
          let writtenPitch = n.pitch - part.transposeChromatic + ottSemitones;
          let writtenTpc = n.tpc2 !== null && part.transposeChromatic ? n.tpc2 : (n.tpc !== null ? n.tpc - part.tFifths : null);
          const s = spell(writtenPitch, writtenTpc);
          x += `<pitch><step>${s.step}</step>${s.alter ? `<alter>${s.alter}</alter>` : ''}<octave>${s.octave}</octave></pitch>`;
        }
        if (!ev.grace) x += `<duration>${Math.max(1, ev.duration)}</duration>`;
        if (n.tieStop) x += '<tie type="stop"/>';
        if (n.tieStart) x += '<tie type="start"/>';
        if (part.isDrum) x += `<instrument id="${part.id}-I${n.pitch + 1}"/>`;
        x += `<voice>${voiceNumber}</voice>`;
        if (ev.type) x += `<type>${ev.type}</type>` + '<dot/>'.repeat(ev.dots || 0);
        if (ev.timeMod) x += `<time-modification><actual-notes>${ev.timeMod.actual}</actual-notes><normal-notes>${ev.timeMod.normal}</normal-notes></time-modification>`;
        let head = n.head;
        if (part.isDrum && !head) {
          const d = part.drums.get(n.pitch);
          head = d ? d.head : (DEFAULT_DRUMS[n.pitch] ? DEFAULT_DRUMS[n.pitch][1] : '');
        }
        if (n.dead) head = 'cross';
        if (head && HEADS[head]) x += `<notehead${n.ghost ? ' parentheses="yes"' : ''}>${HEADS[head]}</notehead>`;
        else if (n.ghost) x += '<notehead parentheses="yes">normal</notehead>';
        x += staffTag;

        const notations = [];
        if (n.tieStop) notations.push('<tied type="stop"/>');
        if (n.tieStart) notations.push('<tied type="start"/>');
        if ((letRing || n.letRing) && !n.tieStart) notations.push('<tied type="let-ring"/>');
        if (ni === 0) {
          if (ev.tupletStart) notations.push('<tuplet type="start" bracket="yes"/>');
          if (ev.tupletStop) notations.push('<tuplet type="stop"/>');
          // plain slurs; hammer-ons and pull-offs are written as technical marks below
          const slurTech = n.hopo || n.hopoStop;
          if (!slurTech) {
            for (let i = 0; i < ev.slurStop.length; i++) notations.push('<slur type="stop" number="1"/>');
            for (let i = 0; i < ev.slurStart.length; i++) notations.push('<slur type="start" number="1"/>');
          }
          if (ev.fermata) notations.push('<fermata/>');
          if (ev.articulations.length) notations.push(`<articulations>${ev.articulations.map((a) => `<${a}/>`).join('')}</articulations>`);
          if (ev.arpeggio) notations.push('<arpeggiate/>');
          if (ev.tremolo) notations.push(`<ornaments><tremolo type="single">${ev.tremolo}</tremolo></ornaments>`);
        }
        if (vibrato && ni === 0) notations.push('<ornaments><wavy-line type="start"/></ornaments>');
        if (n.slideOut) notations.push('<slide type="start" line-type="solid"/>');
        if (n.slideIn) notations.push('<slide type="stop" line-type="solid"/>');

        const technical = [];
        const stringed = part.isPlucked;
        if (stringed) {
          let string = n.string;
          let fret = n.fret;
          if (string === null || fret === null || string < 0 || fret < 0 || string >= part.strings.length) {
            // no tab information: put the note on the highest string that can play it
            const tuning = part.strings.slice().reverse(); // high to low, index = MuseScore string number
            string = null;
            for (let i = 0; i < tuning.length; i++) {
              const f = n.pitch - tuning[i];
              if (f >= 0 && f <= Math.max(part.frets, 24)) { string = i; fret = f; break; }
            }
          }
          if (string !== null && fret !== null) {
            technical.push(`<string>${string + 1}</string><fret>${fret}</fret>`);
          }
        }
        if (n.hopo) technical.push(`<${n.hopo} type="start">${n.hopo === 'hammer-on' ? 'H' : 'P'}</${n.hopo}>`);
        if (n.hopoStop) technical.push(`<${n.hopoStop} type="stop"/>`);
        if (ev.tap) technical.push('<tap/>');
        if (n.bendAlter !== undefined && n.bendAlter !== 0) {
          technical.push(`<bend><bend-alter>${n.bendAlter}</bend-alter>${n.preBend ? '<pre-bend/>' : ''}</bend>`);
        } else if (n.bendPoints && n.bendPoints.length > 1) {
          const max = n.bendPoints.reduce((a, p) => Math.max(a, p.pitch), 0);
          const lastP = n.bendPoints[n.bendPoints.length - 1].pitch;
          if (max > 0) {
            technical.push(`<bend><bend-alter>${Math.round(max / 50) / 2}</bend-alter>${n.bendPoints[0].pitch > 0 ? '<pre-bend/>' : ''}</bend>`);
            if (lastP < max) technical.push(`<bend><bend-alter>${-Math.round((max - lastP) / 50) / 2}</bend-alter><release/></bend>`);
          }
        }
        for (const f of n.fingering) if (/^\d$/.test(f) && !stringed) technical.push(`<fingering>${esc(f)}</fingering>`);
        if (technical.length) notations.push(`<technical>${technical.join('')}</technical>`);

        if (notations.length) x += `<notations>${notations.join('')}</notations>`;
        if (ni === 0) {
          for (const l of ev.lyrics) x += `<lyric number="${l.no}"><syllabic>${esc(l.syllabic)}</syllabic><text>${esc(l.text)}</text></lyric>`;
        }
        if (palmMute || !n.play) x += `<play>${palmMute ? '<mute>palm</mute>' : '<mute>on</mute>'}</play>`;
        x += '</note>';
        out.push(x);
      });
    }
  }

  /* ---------------------------------------------------------------------
     Public API
  --------------------------------------------------------------------- */
  function isMuseScoreName(name) {
    return /\.(mscz|mscx)$/i.test(name || '');
  }

  function browserParse(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('This MuseScore file could not be read (damaged XML).');
    return doc;
  }

  async function toMusicXml(bytes, name, parseXml) {
    const parse = parseXml || browserParse;
    let text;
    const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (isZip) text = await extractMscx(bytes);
    else text = new TextDecoder('utf-8').decode(bytes);
    return mscxToMusicXml(text, parse);
  }

  const api = { isMuseScoreName, toMusicXml, mscxToMusicXml, extractMscx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ScoreMuseScore = api;
})(typeof window !== 'undefined' ? window : globalThis);
