/* Score: offline Guitar Pro player
   Built on alphaTab (https://alphatab.net, MPL-2.0).
   No accounts, no uploads, no AI. Everything runs in this browser. */
(function () {
  'use strict';

  const APP_VERSION = '1.1.0';
  const SETTINGS_KEY = 'score.settings.v1';
  const DB_NAME = 'score-library';
  const DB_STORE = 'songs';
  const SOUND_URL = 'sounds/score.sf3';
  const SOUND_BYTES = 17992588;            // used for the progress bar when the server sends no length
  const SOUND_CACHE = 'score-sounds-v1';   // kept apart from the app cache so app updates do not download the sounds again

  const $ = (id) => document.getElementById(id);
  const app = $('app');

  const els = {
    viewport: $('viewport'),
    alphaTab: $('alphaTab'),
    dropzone: $('dropzone'),
    loading: $('loading'),
    loadingText: $('loadingText'),
    fileInput: $('fileInput'),
    songMeta: $('songMeta'),
    songTitle: $('songTitle'),
    songArtist: $('songArtist'),
    trackList: $('trackList'),
    loopStart: $('loopStart'),
    loopEnd: $('loopEnd'),
    progress: $('progress'),
    timeCurrent: $('timeCurrent'),
    timeTotal: $('timeTotal'),
    barIndicator: $('barIndicator'),
    speed: $('speed'),
    speedValue: $('speedValue'),
    bpmValue: $('bpmValue'),
    zoomValue: $('zoomValue'),
    masterVolume: $('masterVolume'),
    soundStatus: $('soundStatus'),
    soundStatusText: $('soundStatusText'),
    soundStatusBar: $('soundStatusBar'),
    btnReverb: $('btnReverb'),
    btnPlay: $('btnPlay'),
    btnStop: $('btnStop'),
    btnLoop: $('btnLoop'),
    btnMetronome: $('btnMetronome'),
    btnCountIn: $('btnCountIn'),
    libraryDialog: $('libraryDialog'),
    libraryList: $('libraryList'),
    libraryCount: $('libraryCount'),
    helpDialog: $('helpDialog'),
    toast: $('toast'),
    sidebar: $('sidebar'),
  };

  /* ---------------------------------------------------------------------
     Persistent UI settings (localStorage)
  --------------------------------------------------------------------- */
  const defaults = {
    theme: 'dark',
    layout: 'page',
    notation: 'scoretab',
    zoom: 1,
    metronome: false,
    countIn: false,
    masterVolume: 1,
    guitarSound: 'original',   // original | acoustic | electric | nylon
    reverb: true,
    sidebarHidden: window.innerWidth < 900,
  };
  let settings = Object.assign({}, defaults);
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* ignore */ }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------------
     Runtime state
  --------------------------------------------------------------------- */
  const state = {
    api: null,
    score: null,
    fileName: '',
    songId: null,          // library id of the open song
    isDemo: false,
    speed: 1,
    loopOn: false,
    loopStartBar: null,    // 1-based
    loopEndBar: null,      // 1-based
    currentBar: 1,         // 1-based
    endTime: 0,
    seeking: false,
    visible: new Set(),    // track indexes rendered
    mute: new Set(),
    solo: new Set(),
    volume: new Map(),     // track index -> 0..1.5
    dragDepth: 0,
    practiceSaveTimer: null,
    playerReady: false,
    awaitMidi: false,
    awaitRender: false,
    rehighlightAfterRender: false,
    loads: 0,
    soundsReady: false,
    resume: null,          // { tick, play } restored after the sound of a track was changed
  };

  /* ---------------------------------------------------------------------
     Theme and notation colours
  --------------------------------------------------------------------- */
  const themes = {
    dark: {
      mainGlyphColor: '#e6edf3',
      secondaryGlyphColor: '#9fb0c0',
      staffLineColor: '#4c5a69',
      barSeparatorColor: '#7a8794',
      barNumberColor: '#22d3ee',
      scoreInfoColor: '#e6edf3',
    },
    light: {
      mainGlyphColor: '#111827',
      secondaryGlyphColor: '#4b5563',
      staffLineColor: '#6b7280',
      barSeparatorColor: '#374151',
      barNumberColor: '#0891b2',
      scoreInfoColor: '#111827',
    },
  };

  function applyTheme(theme, rerender) {
    settings.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b0f14' : '#eef1f5');
    if (state.api) {
      const res = state.api.settings.display.resources;
      const colors = themes[theme];
      for (const key of Object.keys(colors)) {
        res[key] = alphaTab.model.Color.fromJson(colors[key]);
      }
      state.api.updateSettings();
      if (rerender && state.score) state.api.render();
    }
    saveSettings();
  }

  /* ---------------------------------------------------------------------
     alphaTab setup
  --------------------------------------------------------------------- */
  function staveProfileFor(notation) {
    switch (notation) {
      case 'tab': return alphaTab.StaveProfile.Tab;
      case 'score': return alphaTab.StaveProfile.Score;
      default: return alphaTab.StaveProfile.ScoreTab;
    }
  }
  function layoutModeFor(layout) {
    return layout === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
  }

  function createApi() {
    const api = new alphaTab.AlphaTabApi(els.alphaTab, {
      core: {
        fontDirectory: 'vendor/alphatab/font/',
        logLevel: 'warning',
        tex: false,
        enableLazyLoading: true,
      },
      display: {
        layoutMode: layoutModeFor(settings.layout),
        staveProfile: staveProfileFor(settings.notation),
        scale: settings.zoom,
        resources: themes[settings.theme],
      },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
        scrollElement: els.viewport,
        scrollOffsetY: -40,
        scrollOffsetX: -40,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        enableSeekToClick: true,
        enablePlaybackRangeSelection: true,
        resetPlaybackRangeOnClick: false,
      },
    });
    state.api = api;

    api.error.on((err) => {
      console.error('[Score] alphaTab error', err);
      hideLoading();
      toast('Could not read this file: ' + (err && err.message ? err.message : 'unsupported or damaged'), true);
    });

    api.scoreLoaded.on((score) => onScoreLoaded(score));

    api.renderStarted.on(() => {
      if (state.score) showLoading('Rendering');
    });
    api.renderFinished.on(() => hideLoading());
    // postRenderFinished runs after alphaTab has refreshed its own cursor and selection against the new layout
    api.postRenderFinished.on(() => {
      state.awaitRender = false;
      maybeApplyPractice();
      if (state.rehighlightAfterRender) {
        state.rehighlightAfterRender = false;
        rehighlightLoop();
      }
    });

    api.playerReady.on(() => {
      state.playerReady = true;
      updatePlayEnabled();
    });
    api.soundFontLoaded.on(() => {
      state.playerReady = true;
      state.soundsReady = true;
      setSoundStatus(null);
      updatePlayEnabled();
    });
    const loadFailed = api.soundFontLoadFailed || (api.player && api.player.soundFontLoadFailed);
    if (loadFailed && loadFailed.on) {
      loadFailed.on((err) => {
        console.error('[Score] sound bank rejected', err);
        setSoundStatus('Sounds could not be loaded', 0, true);
      });
    }

    api.midiLoaded.on((args) => {
      state.endTime = args.endTime;
      els.timeTotal.textContent = fmtTime(args.endTime);
      updatePlayEnabled();
      state.awaitMidi = false;
      maybeApplyPractice();
      restoreAfterSoundChange();
    });

    api.playerStateChanged.on((args) => {
      const playing = args.state === alphaTab.synth.PlayerState.Playing;
      app.classList.toggle('playing', playing);
    });

    api.playerPositionChanged.on((args) => {
      state.endTime = args.endTime;
      if (!state.seeking) {
        els.progress.value = args.endTime > 0 ? Math.round((args.currentTime / args.endTime) * 1000) : 0;
        els.timeCurrent.textContent = fmtTime(args.currentTime);
      }
      els.timeTotal.textContent = fmtTime(args.endTime);
      updateBpm(args.originalTempo, args.modifiedTempo);
      updateBarFromTick(args.currentTick);
    });

    api.playedBeatChanged.on((beat) => {
      if (beat && beat.voice && beat.voice.bar) {
        setCurrentBar(beat.voice.bar.index + 1);
      }
    });

    api.playbackRangeChanged.on((args) => {
      const range = args.playbackRange;
      if (!range) {
        state.loopStartBar = null;
        state.loopEndBar = null;
        els.loopStart.value = '';
        els.loopEnd.value = '';
        setLoop(false, true);
      } else {
        const bars = barsForRange(range);
        if (bars) {
          state.loopStartBar = bars[0];
          state.loopEndBar = bars[1];
          els.loopStart.value = bars[0];
          els.loopEnd.value = bars[1];
        }
        setLoop(true, true);
      }
      schedulePracticeSave();
    });

    api.playerFinished.on(() => {
      // nothing special; alphaTab resets to start
    });

    // Initial player flags
    api.metronomeVolume = settings.metronome ? 1 : 0;
    api.countInVolume = settings.countIn ? 1 : 0;
    api.masterVolume = settings.masterVolume;
    return api;
  }

  /* ---------------------------------------------------------------------
     Sound bank: downloaded once, kept in its own cache, then loaded from there (also offline)
  --------------------------------------------------------------------- */
  function setSoundStatus(text, fraction, isError) {
    if (!text) { els.soundStatus.hidden = true; return; }
    els.soundStatus.hidden = false;
    els.soundStatus.classList.toggle('error', !!isError);
    els.soundStatusText.textContent = text;
    els.soundStatusBar.style.width = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100) + '%';
  }

  async function readCachedSounds() {
    if (!('caches' in window)) return null;
    try {
      const cache = await caches.open(SOUND_CACHE);
      const hit = await cache.match(SOUND_URL);
      if (!hit) return null;
      const bytes = new Uint8Array(await hit.arrayBuffer());
      return bytes.byteLength > 1000000 ? bytes : null;
    } catch (e) {
      return null;
    }
  }

  async function downloadSounds() {
    const res = await fetch(SOUND_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('Content-Length')) || SOUND_BYTES;
    let bytes;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.byteLength;
        setSoundStatus('Downloading sounds ' + Math.min(99, Math.round((received / total) * 100)) + '% (one time)', received / total);
      }
      bytes = new Uint8Array(received);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    // Keep a copy for offline use. The service worker serves this same cache entry.
    try {
      if ('caches' in window) {
        const cache = await caches.open(SOUND_CACHE);
        await cache.put(SOUND_URL, new Response(bytes.slice().buffer, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
        }));
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) { /* storage full or unavailable: sounds still work for this visit */ }
    return bytes;
  }

  async function loadSounds() {
    setSoundStatus('Loading sounds', 0.02);
    let bytes = await readCachedSounds();
    if (!bytes) {
      try {
        bytes = await downloadSounds();
      } catch (e) {
        console.error('[Score] sound download failed', e);
        setSoundStatus('Sounds not downloaded yet. Connect to the internet once, then reload.', 0, true);
        return;
      }
    }
    setSoundStatus('Preparing sounds', 1);
    if (!state.api.loadSoundFont(bytes, false)) setSoundStatus('Sounds could not be loaded', 0, true);
  }

  /* ---------------------------------------------------------------------
     Guitar sound: play every guitar track as written, or as acoustic, electric or nylon
  --------------------------------------------------------------------- */
  const GUITAR_SOUNDS = {
    original: { program: null, label: 'Original' },
    acoustic: { program: 25, label: 'Acoustic' },
    electric: { program: 27, label: 'Electric' },
    nylon: { program: 24, label: 'Nylon' },
  };
  const AUTOMATION_INSTRUMENT = 2;
  const AUTOMATION_BANK = 5;
  const originalSounds = new WeakMap(); // track -> { program, automations: [[automation, value], ...] }

  function isPercussionTrack(track) {
    return (track.playbackInfo && track.playbackInfo.primaryChannel === 9) || track.staves.some((st) => st.isPercussion);
  }

  function eachAutomation(track, fn) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.automations) for (const automation of beat.automations) fn(automation);
          }
        }
      }
    }
  }

  // Runs before alphaTab generates the MIDI for a song, and again whenever the choice changes.
  function applyGuitarSound(score) {
    const choice = GUITAR_SOUNDS[settings.guitarSound] || GUITAR_SOUNDS.original;
    for (const track of score.tracks) {
      if (isPercussionTrack(track)) continue;
      let orig = originalSounds.get(track);
      if (!orig) {
        orig = { program: track.playbackInfo.program, automations: [] };
        eachAutomation(track, (a) => {
          if (a.type === AUTOMATION_INSTRUMENT) orig.automations.push([a, a.value]);
          // The sound bank only has the standard bank; other banks would leave the track silent.
          if (a.type === AUTOMATION_BANK) a.value = 0;
        });
        track.playbackInfo.bank = 0;
        originalSounds.set(track, orig);
      }
      const isGuitar = orig.program >= 24 && orig.program <= 31;
      const override = isGuitar && choice.program !== null;
      track.playbackInfo.program = override ? choice.program : orig.program;
      for (const [automation, value] of orig.automations) automation.value = override ? choice.program : value;
    }
  }

  function setGuitarSound(value) {
    if (!GUITAR_SOUNDS[value]) value = 'original';
    const changed = settings.guitarSound !== value;
    settings.guitarSound = value;
    document.querySelectorAll('#segSound button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
    saveSettings();
    if (!changed || !state.score || !state.api) return;
    applyGuitarSound(state.score);
    refreshTrackSubtitles();
    // New instruments need new MIDI. Remember where we were and carry on from there.
    const api = state.api;
    state.resume = {
      tick: api.tickPosition,
      play: api.playerState === alphaTab.synth.PlayerState.Playing,
    };
    api.loadMidiForScore();
    const guitars = state.score.tracks.filter((t) => { const o = originalSounds.get(t); return o && o.program >= 24 && o.program <= 31; }).length;
    toast(guitars ? `Guitar sound: ${GUITAR_SOUNDS[value].label}` : 'This song has no guitar tracks to change.');
  }

  function restoreAfterSoundChange() {
    const resume = state.resume;
    if (!resume) return;
    state.resume = null;
    const api = state.api;
    try {
      if (state.loopStartBar && state.loopEndBar) {
        const loopWasOn = state.loopOn;
        setLoopBars(state.loopStartBar, state.loopEndBar, false);
        if (!loopWasOn) setLoop(false, true);
      }
      if (resume.tick > 0) api.tickPosition = resume.tick;
      if (resume.play) {
        // the synth reports ready a moment after the MIDI event; start as soon as it can
        const start = () => { if (api.isReadyForPlayback) api.play(); else setTimeout(start, 40); };
        start();
      }
    } catch (e) { /* position is a convenience only */ }
  }

  /* ---------------------------------------------------------------------
     Output chain: a little room reverb and a safety limiter between alphaTab and the speakers.
     alphaTab connects its output node straight to the destination, so that one connection is
     redirected through this chain. Everything else in the Web Audio graph is left alone.
  --------------------------------------------------------------------- */
  const fx = { ctx: null, input: null, wet: null, limiter: null, post: null };
  const REVERB_LEVEL = 0.2;
  const OUTPUT_BOOST = 1.4;   // Guitar Pro files mix quietly; the limiter below catches the rare loud one

  function buildImpulse(ctx) {
    // A small bright room: 14 ms pre-delay, about one second of decaying, slowly darkening noise.
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * 1.25);
    const pre = Math.floor(rate * 0.014);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let seed = ch === 0 ? 0x1234abcd : 0x9e3779b9;
      let low = 0;
      for (let i = pre; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = seed / 2147483648 - 1;
        const t = (i - pre) / rate;
        const smooth = 0.35 + Math.min(0.55, t * 0.9);   // more low-pass as the tail goes on
        low = low * smooth + noise * (1 - smooth);
        data[i] = low * Math.exp(-t * 5.2);
      }
    }
    return buffer;
  }

  function buildOutputChain(ctx) {
    const input = ctx.createGain();
    input.gain.value = OUTPUT_BOOST;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const post = ctx.createGain();
    post.gain.value = 0.8;   // refined below once the make-up gain of this browser is known
    const convolver = ctx.createConvolver();
    convolver.buffer = buildImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = settings.reverb ? REVERB_LEVEL : 0;
    input.connect(limiter);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(limiter);
    limiter.connect(post);
    post.connect(ctx.destination);
    fx.ctx = ctx; fx.input = input; fx.wet = wet; fx.limiter = limiter; fx.post = post;
    calibrateLimiter(ctx.sampleRate);
    return input;
  }

  // Browsers add their own make-up gain inside the compressor. Measure it once with a quiet tone and
  // cancel it, so the limiter only acts on peaks and normal playing keeps its level.
  function calibrateLimiter(sampleRate) {
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Offline) return;
      const off = new Offline(1, Math.floor(sampleRate * 0.5), sampleRate);
      const osc = off.createOscillator();
      osc.frequency.value = 440;
      const quiet = off.createGain();
      quiet.gain.value = 0.05;
      const comp = off.createDynamicsCompressor();
      comp.threshold.value = fx.limiter.threshold.value;
      comp.knee.value = fx.limiter.knee.value;
      comp.ratio.value = fx.limiter.ratio.value;
      comp.attack.value = fx.limiter.attack.value;
      comp.release.value = fx.limiter.release.value;
      osc.connect(quiet); quiet.connect(comp); comp.connect(off.destination);
      osc.start(0);
      const done = (rendered) => {
        const d = rendered.getChannelData(0);
        let peak = 0;
        for (let i = Math.floor(d.length / 2); i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        const makeup = peak / 0.05;
        if (makeup > 0.5 && makeup < 4 && fx.post) fx.post.gain.value = 1 / makeup;
      };
      const promise = off.startRendering();
      if (promise && promise.then) promise.then(done).catch(() => {});
      else off.oncomplete = (e) => done(e.renderedBuffer);
    } catch (e) { /* keep the default trim */ }
  }

  function installOutputChain() {
    if (!window.AudioNode || !AudioNode.prototype.connect) return;
    const nativeConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target) {
      try {
        const isSynthOutput = (window.AudioWorkletNode && this instanceof AudioWorkletNode) ||
          (window.ScriptProcessorNode && this instanceof ScriptProcessorNode);
        if (isSynthOutput && target === this.context.destination) {
          const chainInput = fx.ctx === this.context && fx.input ? fx.input : buildOutputChain(this.context);
          return nativeConnect.call(this, chainInput);
        }
      } catch (e) {
        console.warn('[Score] output chain unavailable, playing dry', e);
      }
      return nativeConnect.apply(this, arguments);
    };
  }

  function setReverb(on) {
    settings.reverb = !!on;
    els.btnReverb.setAttribute('aria-pressed', settings.reverb ? 'true' : 'false');
    if (fx.wet && fx.ctx) fx.wet.gain.setTargetAtTime(settings.reverb ? REVERB_LEVEL : 0, fx.ctx.currentTime, 0.05);
    saveSettings();
  }

  /* ---------------------------------------------------------------------
     Loading files
  --------------------------------------------------------------------- */
  const pending = { name: '', bytes: null, saveToLibrary: false, practice: null, songId: null };

  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function showLoading(text) {
    els.loadingText.textContent = text || 'Loading';
    els.loading.hidden = false;
  }
  function hideLoading() { els.loading.hidden = true; }

  async function openFile(file) {
    if (!file) return;
    showLoading('Reading ' + file.name);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const id = await hashBytes(bytes, file.name);
      const existing = await dbGet(id).catch(() => null);
      pending.name = file.name;
      pending.bytes = bytes;
      pending.songId = id;
      pending.saveToLibrary = true;
      pending.practice = existing && existing.practice ? existing.practice : null;
      state.isDemo = false;
      loadBytes(bytes, file.name);
    } catch (e) {
      hideLoading();
      toast('Could not read the file.', true);
    }
  }

  // Drop anything that still points at the previous song before a new one is loaded.
  function resetForNewScore() {
    const api = state.api;
    if (!api) return;
    neutralizeHighlight();
    api.playbackRange = null;
    setLoop(false, true);
    lastBarTick = -1;
    lastTempo = { original: 0, modified: 0 };
    state.awaitMidi = true;
    state.awaitRender = true;
    state.rehighlightAfterRender = false;
  }

  // Tracks to render right away (saved practice state or the first track), so the first render is the final one.
  function initialTrackIndexes() {
    const p = pending.practice;
    if (p && Array.isArray(p.visible) && p.visible.length) return p.visible.slice().sort((a, b) => a - b);
    return [0];
  }

  // Parse on the main thread first so the text encoding can be picked before alphaTab renders anything.
  function parseScore(bytes, name) {
    const api = state.api;
    const importer = api.settings.importer;
    let score = null;
    try {
      importer.gp3To5encoding = 'windows-1252';
      score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings);
      if (/\.gp[345]$/i.test(name || '') && looksLikeMojibake(score)) {
        importer.gp3To5encoding = 'utf-8';
        const utf8 = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings);
        if (!looksLikeMojibake(utf8)) score = utf8;
      }
    } catch (e) {
      score = null;
    }
    importer.gp3To5encoding = 'windows-1252';
    return score;
  }

  function loadBytes(bytes, name) {
    showLoading('Opening ' + name);
    state.fileName = name;
    resetForNewScore();
    const score = parseScore(bytes, name);
    let ok = false;
    try {
      ok = state.api.load(score || bytes, initialTrackIndexes());
    } catch (e) {
      console.error('[Score] could not open', name, e);
      hideLoading();
      toast(score ? 'Something went wrong while opening this file.' : 'This file type is not supported.', true);
      return;
    }
    if (!ok) {
      hideLoading();
      toast('This file type is not supported.', true);
    }
  }

  function openLibrarySong(record) {
    // The library stores an ArrayBuffer; everything else in Score works with a Uint8Array view of it.
    const bytes = record.data instanceof Uint8Array ? record.data : new Uint8Array(record.data);
    pending.name = record.name;
    pending.bytes = bytes;
    pending.songId = record.id;
    pending.saveToLibrary = true;
    pending.practice = record.practice || null;
    state.isDemo = false;
    loadBytes(bytes, record.name);
  }

  function openDemo() {
    pending.name = 'Demo Riff';
    pending.bytes = null;
    pending.songId = null;
    pending.saveToLibrary = false;
    pending.practice = null;
    state.isDemo = true;
    state.fileName = 'Demo Riff';
    showLoading('Opening demo');
    resetForNewScore();
    state.api.tex(DEMO_TEX);
  }

  // Guitar Pro 3 to 5 files are decoded as Windows-1252 (what Guitar Pro writes). Files written by other
  // tools (TuxGuitar for example) are often UTF-8 instead, which shows up as "Ã©" style garbage. When that
  // pattern appears we reload the same bytes once as UTF-8.
  function looksLikeMojibake(score) {
    const text = [score.title, score.subTitle, score.artist, score.album, score.words, score.music, score.copyright, score.tab, score.instructions]
      .concat(score.tracks.map((t) => t.name)).join(' ');
    return /[ÃÂ][\u0080-¿]/.test(text) || /â\u0080[\u0090-¦]/.test(text);
  }

  function onScoreLoaded(score) {
    applyGuitarSound(score);
    state.score = score;
    state.songId = pending.songId;
    state.loads++;
    app.classList.remove('no-song');

    // Header
    const title = score.title || pending.name.replace(/\.[^.]+$/, '') || 'Untitled';
    els.songTitle.textContent = title;
    els.songArtist.textContent = score.artist || '';
    els.songMeta.hidden = false;
    document.title = title + ' | Score';

    // Reset mix + loop state
    state.mute.clear();
    state.solo.clear();
    state.volume.clear();
    state.visible = new Set([0]);
    state.loopStartBar = null;
    state.loopEndBar = null;
    els.loopStart.value = '';
    els.loopEnd.value = '';
    els.loopStart.max = score.masterBars.length;
    els.loopEnd.max = score.masterBars.length;
    setLoop(false, true);
    setCurrentBar(1);
    els.progress.value = 0;
    els.timeCurrent.textContent = '0:00';

    // Speed back to 100% unless the song has saved practice data
    const practice = pending.practice;
    setSpeed(practice && practice.speed ? practice.speed : 1, true);

    if (practice) {
      if (Array.isArray(practice.visible) && practice.visible.length) {
        state.visible = new Set(practice.visible.filter((i) => i < score.tracks.length));
        if (!state.visible.size) state.visible = new Set([0]);
      }
      if (Array.isArray(practice.mute)) practice.mute.forEach((i) => { if (i < score.tracks.length) state.mute.add(i); });
      if (Array.isArray(practice.solo)) practice.solo.forEach((i) => { if (i < score.tracks.length) state.solo.add(i); });
      if (practice.volume && typeof practice.volume === 'object') {
        Object.keys(practice.volume).forEach((k) => state.volume.set(Number(k), practice.volume[k]));
      }
    }

    buildTrackList();
    applyMix();
    // alphaTab already started rendering the tracks passed to load(); only re-render if they differ.
    const rendered = (state.api.tracks || []).map((t) => t.index).sort((a, b) => a - b).join(',');
    const wanted = [...state.visible].sort((a, b) => a - b).join(',');
    if (rendered !== wanted) renderVisibleTracks();
    else refreshTrackRows();

    // Persist to library
    if (pending.saveToLibrary && pending.bytes) {
      dbPut({
        id: pending.songId,
        name: pending.name,
        title: score.title || '',
        artist: score.artist || '',
        size: pending.bytes.byteLength,
        added: Date.now(),
        opened: Date.now(),
        data: pending.bytes.buffer.slice(pending.bytes.byteOffset, pending.bytes.byteOffset + pending.bytes.byteLength),
        practice: practice || null,
        tracks: score.tracks.length,
        bars: score.masterBars.length,
      }, true).catch(() => { /* storage may be unavailable */ });
    }

    // Remember recently used file name for the title hint
    toast(`Loaded ${title}: ${score.tracks.length} track${score.tracks.length === 1 ? '' : 's'}, ${score.masterBars.length} bars`);
  }

  // Applied once the new score is both rendered (bounds exist) and its midi is ready (tick cache exists)
  function maybeApplyPractice() {
    if (state.awaitMidi || state.awaitRender) return;
    const practice = pending.practice;
    pending.practice = null;
    if (!practice || !state.score) return;
    if (practice.loopStart && practice.loopEnd) {
      setLoopBars(practice.loopStart, practice.loopEnd, false);
    }
  }

  /* ---------------------------------------------------------------------
     Tracks: visibility, mute, solo, volume
  --------------------------------------------------------------------- */
  function buildTrackList() {
    const score = state.score;
    els.trackList.innerHTML = '';
    score.tracks.forEach((track, i) => {
      const row = document.createElement('div');
      row.className = 'track';
      row.dataset.index = i;

      const vis = document.createElement('label');
      vis.className = 'track-vis';
      vis.title = 'Show this track in the sheet';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.visible.has(i);
      cb.addEventListener('change', () => {
        if (cb.checked) state.visible.add(i);
        else {
          if (state.visible.size === 1) { cb.checked = true; return; }
          state.visible.delete(i);
        }
        renderVisibleTracks();
        schedulePracticeSave();
      });
      vis.appendChild(cb);

      const name = document.createElement('div');
      name.className = 'track-name';
      name.title = 'Click to show only this track';
      const dot = document.createElement('span');
      dot.className = 'track-color';
      dot.style.background = track.color ? track.color.rgba : 'var(--accent)';
      const label = document.createElement('span');
      label.className = 'track-label';
      label.textContent = track.name || ('Track ' + (i + 1));
      const sub = document.createElement('small');
      sub.textContent = trackSubtitle(track);
      name.append(dot, label, sub);
      name.addEventListener('click', () => {
        state.visible = new Set([i]);
        els.trackList.querySelectorAll('.track-vis input').forEach((input, j) => { input.checked = j === i; });
        renderVisibleTracks();
        schedulePracticeSave();
      });

      const btns = document.createElement('div');
      btns.className = 'track-btns';
      const m = document.createElement('button');
      m.textContent = 'M';
      m.title = 'Mute';
      m.addEventListener('click', () => {
        if (state.mute.has(i)) state.mute.delete(i); else state.mute.add(i);
        applyMix();
        schedulePracticeSave();
      });
      const s = document.createElement('button');
      s.textContent = 'S';
      s.title = 'Solo';
      s.addEventListener('click', () => {
        if (state.solo.has(i)) state.solo.delete(i); else state.solo.add(i);
        applyMix();
        schedulePracticeSave();
      });
      btns.append(m, s);

      const vol = document.createElement('input');
      vol.type = 'range';
      vol.className = 'track-vol';
      vol.min = 0; vol.max = 150; vol.step = 5;
      vol.value = Math.round((state.volume.has(i) ? state.volume.get(i) : 1) * 100);
      vol.title = 'Track volume';
      vol.setAttribute('aria-label', 'Volume for ' + (track.name || 'track ' + (i + 1)));
      vol.addEventListener('input', () => {
        state.volume.set(i, vol.value / 100);
        state.api.changeTrackVolume([track], vol.value / 100);
        schedulePracticeSave();
      });

      row.append(vis, name, btns, vol);
      els.trackList.appendChild(row);
    });
    refreshTrackRows();
  }

  function trackSubtitle(track) {
    const info = track.playbackInfo;
    if (!info) return '';
    if (info.primaryChannel === 9) return 'drums';
    const names = GM_NAMES;
    const n = names[info.program];
    return n ? n : '';
  }

  function refreshTrackSubtitles() {
    if (!state.score) return;
    els.trackList.querySelectorAll('.track').forEach((row) => {
      const track = state.score.tracks[Number(row.dataset.index)];
      const sub = row.querySelector('.track-name small');
      if (track && sub) sub.textContent = trackSubtitle(track);
    });
  }

  function refreshTrackRows() {
    els.trackList.querySelectorAll('.track').forEach((row) => {
      const i = Number(row.dataset.index);
      row.classList.toggle('visible', state.visible.has(i));
      const effectiveMuted = state.mute.has(i) || (state.solo.size > 0 && !state.solo.has(i));
      row.classList.toggle('muted', effectiveMuted);
      const [m, s] = row.querySelectorAll('.track-btns button');
      m.classList.toggle('on-mute', state.mute.has(i));
      s.classList.toggle('on-solo', state.solo.has(i));
    });
  }

  function applyMix() {
    const api = state.api;
    const score = state.score;
    if (!api || !score) return;
    score.tracks.forEach((track, i) => {
      api.changeTrackMute([track], state.mute.has(i));
      api.changeTrackSolo([track], state.solo.has(i));
      const v = state.volume.has(i) ? state.volume.get(i) : 1;
      api.changeTrackVolume([track], v);
    });
    refreshTrackRows();
  }

  function renderVisibleTracks() {
    const score = state.score;
    if (!score) return;
    const tracks = [...state.visible].sort((a, b) => a - b).map((i) => score.tracks[i]).filter(Boolean);
    if (!tracks.length) tracks.push(score.tracks[0]);
    // The loop highlight is tied to beats of a rendered track: park it now, redraw it after the render.
    if (state.loopStartBar) {
      neutralizeHighlight();
      state.rehighlightAfterRender = true;
    }
    state.api.renderTracks(tracks);
    refreshTrackRows();
  }

  // alphaTab keeps the selected beats around and redraws them after every render. If those beats belong
  // to a track that is no longer shown (or to a previous song) the redraw fails, so we point the selection
  // at a single beat of a visible track instead, which draws nothing and never fails.
  function neutralizeHighlight() {
    const api = state.api;
    if (!api || !state.score) return;
    try {
      const track = (api.tracks && api.tracks[0]) || state.score.tracks[0];
      const beat = track && track.staves[0] && track.staves[0].bars[0] && track.staves[0].bars[0].voices[0] && track.staves[0].bars[0].voices[0].beats[0];
      if (beat) api.highlightPlaybackRange(beat, beat);
      else api.clearPlaybackRangeHighlight();
    } catch (e) { /* ignore */ }
  }

  function rehighlightLoop() {
    if (!state.loopStartBar || !state.loopEndBar || !state.api) return;
    try {
      const startBeat = beatsOfBar(state.loopStartBar - 1, false);
      const endBeat = beatsOfBar(state.loopEndBar - 1, true);
      if (startBeat && endBeat && startBeat !== endBeat) state.api.highlightPlaybackRange(startBeat, endBeat);
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------------
     Transport
  --------------------------------------------------------------------- */
  function updatePlayEnabled() {
    const ready = !!state.score && !!state.api && state.api.isReadyForPlayback;
    els.btnPlay.disabled = !ready;
  }

  function playPause() {
    if (!state.score) return;
    if (!state.api.isReadyForPlayback) {
      toast('Sounds are still loading, one moment.');
      return;
    }
    state.api.playPause();
  }

  function stop() {
    if (!state.api) return;
    state.api.stop();
    els.progress.value = 0;
    els.timeCurrent.textContent = '0:00';
  }

  function setSpeed(value, silent) {
    value = Math.min(2, Math.max(0.25, Math.round(value * 100) / 100));
    state.speed = value;
    if (state.api) state.api.playbackSpeed = value;
    els.speed.value = Math.round(value * 100);
    els.speedValue.textContent = Math.round(value * 100) + '%';
    updateBpm();
    if (!silent) schedulePracticeSave();
  }

  let lastTempo = { original: 0, modified: 0 };
  function updateBpm(original, modified) {
    if (typeof original === 'number' && original > 0) lastTempo = { original, modified };
    const base = state.score ? (lastTempo.original || state.score.tempo) : 0;
    if (!base) { els.bpmValue.textContent = ''; return; }
    const effective = Math.round(base * state.speed);
    els.bpmValue.textContent = state.speed === 1 ? `${base} bpm` : `${effective} bpm (${base})`;
  }

  function setLoop(on, silent) {
    state.loopOn = !!on;
    if (state.api) state.api.isLooping = state.loopOn;
    els.btnLoop.setAttribute('aria-pressed', state.loopOn ? 'true' : 'false');
    if (!silent) schedulePracticeSave();
  }

  function setMetronome(on) {
    settings.metronome = !!on;
    if (state.api) state.api.metronomeVolume = on ? 1 : 0;
    els.btnMetronome.setAttribute('aria-pressed', on ? 'true' : 'false');
    saveSettings();
  }

  function setCountIn(on) {
    settings.countIn = !!on;
    if (state.api) state.api.countInVolume = on ? 1 : 0;
    els.btnCountIn.setAttribute('aria-pressed', on ? 'true' : 'false');
    saveSettings();
  }

  function setCurrentBar(bar) {
    state.currentBar = bar;
    els.barIndicator.textContent = 'Bar ' + bar + (state.score ? ' / ' + state.score.masterBars.length : '');
  }

  let lastBarTick = -1;
  function updateBarFromTick(tick) {
    const cache = state.api && state.api.tickCache;
    if (!cache || tick === lastBarTick) return;
    lastBarTick = tick;
    for (const mb of cache.masterBars) {
      if (tick >= mb.start && tick < mb.end) {
        const bar = mb.masterBar.index + 1;
        if (bar !== state.currentBar) setCurrentBar(bar);
        return;
      }
    }
  }

  /* ---------------------------------------------------------------------
     Loop section helpers
  --------------------------------------------------------------------- */
  function firstVisibleTrack() {
    const score = state.score;
    const idx = [...state.visible].sort((a, b) => a - b)[0] || 0;
    return score.tracks[idx] || score.tracks[0];
  }

  function beatsOfBar(barIndex, wantLast) {
    const track = firstVisibleTrack();
    for (const staff of track.staves) {
      const bar = staff.bars[barIndex];
      if (!bar) continue;
      for (const voice of bar.voices) {
        if (voice.beats && voice.beats.length) {
          return wantLast ? voice.beats[voice.beats.length - 1] : voice.beats[0];
        }
      }
    }
    // fall back to any track
    for (const t of state.score.tracks) {
      for (const staff of t.staves) {
        const bar = staff.bars[barIndex];
        if (bar && bar.voices[0] && bar.voices[0].beats.length) {
          const beats = bar.voices[0].beats;
          return wantLast ? beats[beats.length - 1] : beats[0];
        }
      }
    }
    return null;
  }

  function setLoopBars(startBar, endBar, announce) {
    const score = state.score;
    if (!score || !state.api) return false;
    const total = score.masterBars.length;
    startBar = Math.max(1, Math.min(total, Math.floor(Number(startBar) || 1)));
    endBar = Math.max(1, Math.min(total, Math.floor(Number(endBar) || startBar)));
    if (endBar < startBar) { const t = startBar; startBar = endBar; endBar = t; }

    const api = state.api;
    const cache = api.tickCache;
    if (!cache) return false;

    const startBeat = beatsOfBar(startBar - 1, false);
    const endBeat = beatsOfBar(endBar - 1, true);
    let applied = false;
    if (startBeat && endBeat && startBeat !== endBeat) {
      // Preferred: let alphaTab draw the selection and derive the range exactly like a mouse drag would.
      try {
        api.highlightPlaybackRange(startBeat, endBeat);
        api.applyPlaybackRangeFromHighlight();
        applied = !!api.playbackRange;
      } catch (e) {
        applied = false;
      }
    }
    if (!applied) {
      // Fallback: build the range from the bar ticks (used for one-beat bars or when bounds are not ready).
      const mbStart = score.masterBars[startBar - 1];
      const mbEnd = score.masterBars[endBar - 1];
      const start = cache.getMasterBarStart(mbStart);
      const end = cache.getMasterBarStart(mbEnd) + mbEnd.calculateDuration() - 50;
      const range = new alphaTab.synth.PlaybackRange();
      range.startTick = start;
      range.endTick = end;
      neutralizeHighlight();
      try { api.playbackRange = range; } catch (e) { /* range is applied even if the marker could not be drawn */ }
      try { api.tickPosition = start; } catch (e) { /* ignore */ }
      state.rehighlightAfterRender = true;
    }
    state.loopStartBar = startBar;
    state.loopEndBar = endBar;
    els.loopStart.value = startBar;
    els.loopEnd.value = endBar;
    setLoop(true, true);
    if (announce) toast(startBar === endBar ? `Looping bar ${startBar}` : `Looping bars ${startBar} to ${endBar}`);
    schedulePracticeSave();
    return true;
  }

  function clearLoop() {
    if (!state.api) return;
    state.api.playbackRange = null;
    neutralizeHighlight();
    state.loopStartBar = null;
    state.loopEndBar = null;
    els.loopStart.value = '';
    els.loopEnd.value = '';
    setLoop(false, true);
    schedulePracticeSave();
  }

  function barsForRange(range) {
    const cache = state.api && state.api.tickCache;
    if (!cache) return null;
    let startBar = null, endBar = null;
    for (const mb of cache.masterBars) {
      if (startBar === null && range.startTick >= mb.start && range.startTick < mb.end) startBar = mb.masterBar.index + 1;
      if (range.endTick > mb.start && range.endTick <= mb.end + 1) endBar = mb.masterBar.index + 1;
    }
    if (startBar === null) startBar = 1;
    if (endBar === null) endBar = startBar;
    return [startBar, Math.max(startBar, endBar)];
  }

  function jumpBars(delta) {
    const score = state.score;
    if (!score || !state.api || !state.api.tickCache) return;
    const target = Math.max(1, Math.min(score.masterBars.length, state.currentBar + delta));
    const mb = score.masterBars[target - 1];
    state.api.tickPosition = state.api.tickCache.getMasterBarStart(mb);
    setCurrentBar(target);
  }

  /* ---------------------------------------------------------------------
     Display settings
  --------------------------------------------------------------------- */
  function setNotation(value) {
    settings.notation = value;
    document.querySelectorAll('#segNotation button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
    if (state.api) {
      state.api.settings.display.staveProfile = staveProfileFor(value);
      state.api.updateSettings();
      if (state.score) state.api.render();
    }
    saveSettings();
  }

  function setLayout(value) {
    settings.layout = value;
    app.classList.toggle('layout-horizontal', value === 'horizontal');
    document.querySelectorAll('#segLayout button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
    if (state.api) {
      state.api.settings.display.layoutMode = layoutModeFor(value);
      state.api.updateSettings();
      if (state.score) state.api.render();
    }
    saveSettings();
  }

  function setZoom(value) {
    value = Math.min(2, Math.max(0.5, Math.round(value * 10) / 10));
    settings.zoom = value;
    els.zoomValue.textContent = Math.round(value * 100) + '%';
    if (state.api) {
      state.api.settings.display.scale = value;
      state.api.updateSettings();
      if (state.score) state.api.render();
    }
    saveSettings();
  }

  function setMasterVolume(v) {
    settings.masterVolume = v;
    if (state.api) state.api.masterVolume = v;
    els.masterVolume.value = Math.round(v * 100);
    saveSettings();
  }

  function setSidebarHidden(hidden) {
    settings.sidebarHidden = !!hidden;
    app.classList.toggle('sidebar-hidden', settings.sidebarHidden);
    saveSettings();
  }

  /* ---------------------------------------------------------------------
     Per-song practice memory (speed, loop, mix) stored in the library
  --------------------------------------------------------------------- */
  function schedulePracticeSave() {
    if (!state.songId) return;
    clearTimeout(state.practiceSaveTimer);
    state.practiceSaveTimer = setTimeout(savePractice, 600);
  }

  async function savePractice() {
    if (!state.songId) return;
    const practice = {
      speed: state.speed,
      loopStart: state.loopStartBar,
      loopEnd: state.loopEndBar,
      visible: [...state.visible],
      mute: [...state.mute],
      solo: [...state.solo],
      volume: Object.fromEntries([...state.volume.entries()]),
    };
    try {
      const rec = await dbGet(state.songId);
      if (rec) {
        rec.practice = practice;
        rec.opened = Date.now();
        await dbPut(rec, false);
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------------
     IndexedDB library
  --------------------------------------------------------------------- */
  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
        store.createIndex('opened', 'opened');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(DB_STORE, mode);
      const store = t.objectStore(DB_STORE);
      const req = fn(store);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  function dbGet(id) { return tx('readonly', (s) => s.get(id)); }
  function dbAll() { return tx('readonly', (s) => s.getAll()); }
  function dbDelete(id) { return tx('readwrite', (s) => s.delete(id)); }
  async function dbPut(record, keepExistingPractice) {
    if (keepExistingPractice) {
      const existing = await dbGet(record.id).catch(() => null);
      if (existing) {
        record.added = existing.added || record.added;
        if (!record.practice && existing.practice) record.practice = existing.practice;
      }
    }
    return tx('readwrite', (s) => s.put(record));
  }

  async function hashBytes(bytes, name) {
    // FNV-1a 32-bit over the bytes plus the file size; fast and good enough for a local library key
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16) + '-' + bytes.length + '-' + (name || '').length;
  }

  async function renderLibrary() {
    let items = [];
    try { items = await dbAll(); } catch (e) { items = []; }
    items.sort((a, b) => (b.opened || 0) - (a.opened || 0));
    els.libraryCount.textContent = items.length ? `${items.length} song${items.length === 1 ? '' : 's'}` : '';
    els.libraryList.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'library-empty';
      empty.textContent = 'Nothing here yet. Every file you open is kept on this device so you can reopen it offline.';
      els.libraryList.appendChild(empty);
      return;
    }
    for (const rec of items) {
      const row = document.createElement('div');
      row.className = 'library-item';
      const title = document.createElement('div');
      title.className = 'li-title';
      title.textContent = rec.title || rec.name;
      const sub = document.createElement('div');
      sub.className = 'li-sub';
      const parts = [];
      if (rec.artist) parts.push(rec.artist);
      parts.push(rec.name);
      if (rec.tracks) parts.push(`${rec.tracks} tr`);
      if (rec.bars) parts.push(`${rec.bars} bars`);
      if (rec.practice && rec.practice.speed && rec.practice.speed !== 1) parts.push(`${Math.round(rec.practice.speed * 100)}%`);
      if (rec.practice && rec.practice.loopStart) parts.push(`loop ${rec.practice.loopStart}-${rec.practice.loopEnd}`);
      sub.textContent = parts.join(' | ');
      const del = document.createElement('button');
      del.className = 'btn icon small li-del';
      del.title = 'Remove from library';
      del.innerHTML = '&times;';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await dbDelete(rec.id).catch(() => {});
        renderLibrary();
      });
      row.append(title, sub, del);
      row.addEventListener('click', () => {
        els.libraryDialog.close();
        openLibrarySong(rec);
      });
      els.libraryList.appendChild(row);
    }
  }

  /* ---------------------------------------------------------------------
     Drag and drop + file picker
  --------------------------------------------------------------------- */
  function isSupportedName(name) {
    return /\.(gp|gpx|gp3|gp4|gp5|xml|musicxml|mxl|capx)$/i.test(name || '');
  }

  async function handleFiles(fileList) {
    const files = [...fileList].filter((f) => isSupportedName(f.name));
    if (!files.length) {
      toast('Drop a Guitar Pro file (.gp, .gpx, .gp3, .gp4, .gp5).', true);
      return;
    }
    await openFile(files[0]);
    if (files.length > 1) {
      let added = 0;
      for (const f of files.slice(1)) {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const id = await hashBytes(bytes, f.name);
          await dbPut({
            id, name: f.name, title: '', artist: '', size: bytes.byteLength,
            added: Date.now(), opened: 0, data: bytes.buffer, practice: null,
          }, true);
          added++;
        } catch (e) { /* skip */ }
      }
      if (added) toast(`${added} more file${added === 1 ? '' : 's'} added to the library.`);
    }
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    state.dragDepth++;
    app.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) app.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    state.dragDepth = 0;
    app.classList.remove('dragging');
    handleFiles(e.dataTransfer.files);
  });
  function hasFiles(e) {
    return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  }

  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files.length) handleFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  $('btnOpen').addEventListener('click', () => els.fileInput.click());
  $('btnOpen2').addEventListener('click', () => els.fileInput.click());
  $('btnDemo').addEventListener('click', openDemo);

  // Opened via the OS "Open with" (PWA file handling)
  if ('launchQueue' in window && window.launchQueue && window.launchQueue.setConsumer) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const file = await params.files[0].getFile();
      openFile(file);
    });
  }

  /* ---------------------------------------------------------------------
     Wire up controls
  --------------------------------------------------------------------- */
  els.btnPlay.addEventListener('click', playPause);
  els.btnStop.addEventListener('click', stop);
  els.btnLoop.addEventListener('click', () => setLoop(!state.loopOn));
  els.btnMetronome.addEventListener('click', () => setMetronome(!settings.metronome));
  els.btnCountIn.addEventListener('click', () => setCountIn(!settings.countIn));

  els.speed.addEventListener('input', () => setSpeed(els.speed.value / 100));
  $('btnSpeedDown').addEventListener('click', () => setSpeed(state.speed - 0.05));
  $('btnSpeedUp').addEventListener('click', () => setSpeed(state.speed + 0.05));
  $('btnSpeedReset').addEventListener('click', () => setSpeed(1));

  els.progress.addEventListener('pointerdown', () => { state.seeking = true; });
  els.progress.addEventListener('input', () => {
    state.seeking = true;
    els.timeCurrent.textContent = fmtTime((els.progress.value / 1000) * state.endTime);
  });
  els.progress.addEventListener('change', () => {
    if (state.api && state.endTime > 0) state.api.timePosition = (els.progress.value / 1000) * state.endTime;
    state.seeking = false;
  });
  els.progress.addEventListener('pointerup', () => { state.seeking = false; });

  els.masterVolume.addEventListener('input', () => setMasterVolume(els.masterVolume.value / 100));
  document.querySelectorAll('#segSound button').forEach((b) => b.addEventListener('click', () => setGuitarSound(b.dataset.value)));
  els.btnReverb.addEventListener('click', () => setReverb(!settings.reverb));

  $('btnLoopApply').addEventListener('click', () => {
    const s = Number(els.loopStart.value) || 1;
    const e = Number(els.loopEnd.value) || s;
    if (!setLoopBars(s, e, true)) toast('Loop could not be set yet. Wait for the song to finish loading.', true);
  });
  $('btnLoopHere').addEventListener('click', () => setLoopBars(state.currentBar, state.currentBar, true));
  $('btnLoopClear').addEventListener('click', clearLoop);
  [els.loopStart, els.loopEnd].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('btnLoopApply').click(); input.blur(); }
    });
  });

  $('btnShowAll').addEventListener('click', () => {
    if (!state.score) return;
    state.visible = new Set(state.score.tracks.map((_, i) => i));
    els.trackList.querySelectorAll('.track-vis input').forEach((input) => { input.checked = true; });
    renderVisibleTracks();
    schedulePracticeSave();
  });
  $('btnResetMix').addEventListener('click', () => {
    if (!state.score) return;
    state.mute.clear(); state.solo.clear(); state.volume.clear();
    els.trackList.querySelectorAll('.track-vol').forEach((v) => { v.value = 100; });
    applyMix();
    schedulePracticeSave();
  });

  document.querySelectorAll('#segNotation button').forEach((b) => b.addEventListener('click', () => setNotation(b.dataset.value)));
  document.querySelectorAll('#segLayout button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.value)));
  $('btnZoomIn').addEventListener('click', () => setZoom(settings.zoom + 0.1));
  $('btnZoomOut').addEventListener('click', () => setZoom(settings.zoom - 0.1));

  $('btnTheme').addEventListener('click', () => applyTheme(settings.theme === 'dark' ? 'light' : 'dark', true));
  $('btnSidebar').addEventListener('click', () => setSidebarHidden(!settings.sidebarHidden));
  $('btnLibrary').addEventListener('click', () => { renderLibrary(); els.libraryDialog.showModal(); });
  $('btnHelp').addEventListener('click', () => els.helpDialog.showModal());
  document.querySelectorAll('.dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog.dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  });

  // Close the sidebar when tapping the sheet on small screens
  els.viewport.addEventListener('pointerdown', () => {
    if (window.innerWidth < 900 && !settings.sidebarHidden) setSidebarHidden(true);
  });

  /* ---------------------------------------------------------------------
     Keyboard shortcuts
  --------------------------------------------------------------------- */
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    const dialogOpen = els.libraryDialog.open || els.helpDialog.open;
    if (e.key === 'Escape') {
      if (dialogOpen) return; // dialog handles it
      if (typing) { e.target.blur(); return; }
      clearLoop();
      return;
    }
    if (typing || dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ': e.preventDefault(); playPause(); break;
      case 's': case 'S': stop(); break;
      case 'l': case 'L': setLoop(!state.loopOn); break;
      case 'm': case 'M': setMetronome(!settings.metronome); break;
      case 'c': case 'C': setCountIn(!settings.countIn); break;
      case 'o': case 'O': els.fileInput.click(); break;
      case 't': case 'T': setSidebarHidden(!settings.sidebarHidden); break;
      case '?': els.helpDialog.showModal(); break;
      case '-': case '_': setSpeed(state.speed - 0.05); break;
      case '+': case '=': setSpeed(state.speed + 0.05); break;
      case '0': setSpeed(1); break;
      case 'ArrowLeft': e.preventDefault(); jumpBars(-1); break;
      case 'ArrowRight': e.preventDefault(); jumpBars(1); break;
      case 'Home': e.preventDefault(); if (state.api) state.api.tickPosition = 0; break;
      case '[': {
        const start = state.currentBar;
        const end = state.loopEndBar && state.loopEndBar >= start ? state.loopEndBar : start;
        setLoopBars(start, end, true);
        break;
      }
      case ']': {
        const end = state.currentBar;
        const start = state.loopStartBar && state.loopStartBar <= end ? state.loopStartBar : 1;
        setLoopBars(start, end, true);
        break;
      }
      default: break;
    }
  });

  /* ---------------------------------------------------------------------
     Toast
  --------------------------------------------------------------------- */
  let toastTimer = null;
  function toast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 5000 : 2600);
  }

  /* ---------------------------------------------------------------------
     Service worker (offline)
  --------------------------------------------------------------------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Score was updated. Reload to use the new version.');
            }
          });
        });
      }).catch((err) => console.warn('[Score] service worker not registered', err));
    });
  }

  /* ---------------------------------------------------------------------
     General MIDI program names (short)
  --------------------------------------------------------------------- */
  const GM_NAMES = [
    'piano', 'bright piano', 'electric grand', 'honky-tonk', 'e-piano 1', 'e-piano 2', 'harpsichord', 'clavinet',
    'celesta', 'glockenspiel', 'music box', 'vibraphone', 'marimba', 'xylophone', 'tubular bells', 'dulcimer',
    'drawbar organ', 'perc organ', 'rock organ', 'church organ', 'reed organ', 'accordion', 'harmonica', 'tango accordion',
    'nylon guitar', 'steel guitar', 'jazz guitar', 'clean guitar', 'muted guitar', 'overdrive guitar', 'distortion guitar', 'harmonics',
    'acoustic bass', 'finger bass', 'pick bass', 'fretless bass', 'slap bass 1', 'slap bass 2', 'synth bass 1', 'synth bass 2',
    'violin', 'viola', 'cello', 'contrabass', 'tremolo strings', 'pizzicato', 'harp', 'timpani',
    'strings 1', 'strings 2', 'synth strings 1', 'synth strings 2', 'choir aahs', 'voice oohs', 'synth voice', 'orchestra hit',
    'trumpet', 'trombone', 'tuba', 'muted trumpet', 'french horn', 'brass', 'synth brass 1', 'synth brass 2',
    'soprano sax', 'alto sax', 'tenor sax', 'baritone sax', 'oboe', 'english horn', 'bassoon', 'clarinet',
    'piccolo', 'flute', 'recorder', 'pan flute', 'bottle', 'shakuhachi', 'whistle', 'ocarina',
    'lead square', 'lead saw', 'lead calliope', 'lead chiff', 'lead charang', 'lead voice', 'lead fifths', 'lead bass',
    'pad new age', 'pad warm', 'pad polysynth', 'pad choir', 'pad bowed', 'pad metallic', 'pad halo', 'pad sweep',
    'fx rain', 'fx soundtrack', 'fx crystal', 'fx atmosphere', 'fx brightness', 'fx goblins', 'fx echoes', 'fx sci-fi',
    'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai',
    'tinkle bell', 'agogo', 'steel drums', 'woodblock', 'taiko', 'melodic tom', 'synth drum', 'reverse cymbal',
    'fret noise', 'breath noise', 'seashore', 'bird tweet', 'telephone', 'helicopter', 'applause', 'gunshot',
  ];

  /* ---------------------------------------------------------------------
     Demo riff (original, written in alphaTex)
  --------------------------------------------------------------------- */
  const DEMO_TEX = `\\title "Demo Riff"
\\subtitle "An original riff to try Score"
\\artist "Score"
\\tempo 96
\\track "Rhythm Guitar" "Rhy"
\\instrument 30
\\tuning E4 B3 G3 D3 A2 E2
.
\\section "Riff A"
:8 0.6 0.6 3.6 0.6 5.6 0.6 3.6 0.6 | 0.6 0.6 3.6 0.6 6.6 0.6 5.6 0.6 |
0.6 0.6 3.6 0.6 5.6 0.6 3.6 0.6 | 0.6 0.6 (3.6 5.5) (3.6 5.5) (2.6 4.5) (2.6 4.5) (0.6 2.5) (0.6 2.5) |
\\section "Riff B"
:8 (5.5 7.4) 5.5 (5.5 7.4) 5.5 (3.5 5.4) 3.5 (3.5 5.4) 3.5 | (1.5 3.4) 1.5 (1.5 3.4) 1.5 :4 (0.6 2.5 2.4) r |
:8 (5.5 7.4) 5.5 (5.5 7.4) 5.5 (3.5 5.4) 3.5 (3.5 5.4) 3.5 | :4 (1.5 3.4) (0.6 2.5 2.4) :2 (0.6 2.5 2.4 1.3 0.2 0.1) |
\\track "Lead Guitar" "Lead"
\\instrument 29
\\tuning E4 B3 G3 D3 A2 E2
.
:4 r r r r | r r r r | r r r r | r r r r |
:8 12.1 15.1 12.1 15.2 14.2 12.2 14.3 12.3 | :4 12.2{b (0 4)} :8 15.2 12.2 :4 14.3{v} |
:8 12.1 15.1 12.1 15.2 14.2 12.2 14.3 12.3 | :2 12.2{v} r |
\\track "Bass" "Bass"
\\instrument 33
\\tuning G2 D2 A1 E1
.
:4 0.4 0.4 3.4 5.4 | 0.4 0.4 3.4 6.4 | 0.4 0.4 3.4 5.4 | 0.4 3.4 2.4 0.4 |
:4 5.3 5.3 3.3 3.3 | 1.3 1.3 0.4 r | 5.3 5.3 3.3 3.3 | 1.3 0.4 :2 0.4 |
\\track "Drums" "Dr"
\\instrument percussion
.
:8 (36 42) 42 (38 42) 42 (36 42) 42 (38 42) 42 | (36 42) 42 (38 42) 42 (36 42) 42 (38 42) 42 |
(36 42) 42 (38 42) 42 (36 42) 42 (38 42) 42 | (36 42) 42 (38 42) 42 (36 42) 36 (38 49) 38 |
(36 42) 42 (38 42) 42 (36 42) 42 (38 42) 42 | (36 42) 42 (38 42) 42 (36 42) 42 (38 42) 42 |
(36 42) 42 (38 42) 42 (36 42) 42 (38 42) 42 | (36 42) 42 (38 42) 42 :4 (36 49) r |
`;

  /* ---------------------------------------------------------------------
     Boot
  --------------------------------------------------------------------- */
  function boot() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    app.classList.toggle('sidebar-hidden', settings.sidebarHidden);
    app.classList.toggle('layout-horizontal', settings.layout === 'horizontal');
    document.querySelectorAll('#segNotation button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.notation));
    document.querySelectorAll('#segLayout button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.layout));
    els.zoomValue.textContent = Math.round(settings.zoom * 100) + '%';
    els.masterVolume.value = Math.round(settings.masterVolume * 100);
    els.btnMetronome.setAttribute('aria-pressed', settings.metronome ? 'true' : 'false');
    els.btnCountIn.setAttribute('aria-pressed', settings.countIn ? 'true' : 'false');
    els.speedValue.textContent = '100%';

    document.querySelectorAll('#segSound button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.guitarSound));
    els.btnReverb.setAttribute('aria-pressed', settings.reverb ? 'true' : 'false');

    if (typeof alphaTab === 'undefined') {
      toast('alphaTab failed to load. Serve Score over http(s), not from file://', true);
      return;
    }
    installOutputChain();
    createApi();
    updatePlayEnabled();
    loadSounds();
    console.info('[Score] v' + APP_VERSION + ' using alphaTab ' + (alphaTab.meta ? alphaTab.meta.version : ''));
  }

  boot();

  // Expose a tiny debug handle (handy in the console, harmless otherwise)
  window.Score = {
    get api() { return state.api; },
    get state() { return state; },
    setLoopBars, clearLoop, setSpeed, openDemo, setGuitarSound, setReverb, fx, version: APP_VERSION,
  };
})();
