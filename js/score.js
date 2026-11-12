/* Score: offline Guitar Pro and MuseScore player
   Built on alphaTab (https://alphatab.net, MPL-2.0).
   No accounts, no uploads, no AI. Everything runs in this browser. */
(function () {
  'use strict';

  const APP_VERSION = '1.2.1';
  const SETTINGS_KEY = 'score.settings.v1';
  const DB_NAME = 'score-library';
  const DB_STORE = 'songs';
  const SOUND_URL = 'sounds/score.sf3';
  const SOUND_BYTES = 18352296;            // used for the progress bar when the server sends no length
  const SOUND_CACHE = 'score-sounds-v2';   // kept apart from the app cache so app updates do not download the sounds again
  const DEMO_KEY = 'demo';
  const MAX_CACHED_SCORES = 6;             // parsed songs kept in memory for instant tab switching

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
    tabBar: $('tabBar'),
    tabList: $('tabList'),
    segBars: $('segBars'),
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
    guitarSound: 'original',   // original | acoustic | electric | nylon | ukulele
    reverb: true,
    openTabs: [],              // keys of the songs open as tabs, restored on the next visit
    activeTab: null,
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
    loadedKey: null,       // tab key of the song alphaTab is showing
    loadToken: 0,          // bumped for every load, so a slow load that was overtaken is dropped
    barsPerRow: -1,        // -1 lets alphaTab fit as many bars as the width allows
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
        barsPerRow: -1,
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
     Guitar sound: play every guitar and ukulele track as written, or as acoustic, electric, nylon or ukulele.
     General MIDI has no ukulele, so files store ukulele parts as nylon guitar (program 24). The sound bank
     adds two ukulele presets on program 24: bank 8 plays notes at their real pitch (for ukulele parts) and
     bank 9 moves notes below middle C up by whole octaves into the ukulele's range (for guitar parts).
  --------------------------------------------------------------------- */
  const GUITAR_SOUNDS = {
    original: { program: null, label: 'Original' },
    acoustic: { program: 25, label: 'Acoustic' },
    electric: { program: 27, label: 'Electric' },
    nylon: { program: 24, label: 'Nylon' },
    ukulele: { program: 24, label: 'Ukulele' },
  };
  const UKULELE_BANK = 8;
  const UKULELE_GUITAR_BANK = 9;
  const AUTOMATION_INSTRUMENT = 2;
  const AUTOMATION_BANK = 5;
  const originalSounds = new WeakMap(); // track -> { program, isGuitar, isUkulele, instruments: [[automation, value]], banks: [automation] }

  function isPercussionTrack(track) {
    return (track.playbackInfo && track.playbackInfo.primaryChannel === 9) || track.staves.some((st) => st.isPercussion);
  }

  // A ukulele part: named like one, or a guitar-family track with four strings tuned between C3 and C5
  // (soprano, concert and tenor GCEA, low G, and baritone DGBE all fit; a bass never does).
  function isUkuleleTrack(track, program) {
    if (/uk[eu]l[ea]le|\buke\b/i.test((track.name || '') + ' ' + (track.shortName || ''))) return true;
    if (program < 24 || program > 31) return false;
    const staff = track.staves[0];
    const tuning = staff && staff.stringTuning ? staff.stringTuning.tunings : (staff && staff.tuning) || [];
    return tuning.length === 4 && tuning.every((p) => p >= 48 && p <= 72);
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

  function soundInfo(track) {
    let info = originalSounds.get(track);
    if (!info) {
      const program = track.playbackInfo.program;
      info = {
        program,
        isGuitar: program >= 24 && program <= 31,
        isUkulele: isUkuleleTrack(track, program),
        instruments: [],
        banks: [],
      };
      eachAutomation(track, (a) => {
        if (a.type === AUTOMATION_INSTRUMENT) info.instruments.push([a, a.value]);
        if (a.type === AUTOMATION_BANK) info.banks.push(a);
      });
      originalSounds.set(track, info);
    }
    return info;
  }

  function hasChangeableSound(track) {
    if (isPercussionTrack(track)) return false;
    const info = soundInfo(track);
    return info.isGuitar || info.isUkulele;
  }

  // Runs before alphaTab generates the MIDI for a song, and again whenever the choice changes.
  function applyGuitarSound(score) {
    const choice = GUITAR_SOUNDS[settings.guitarSound] ? settings.guitarSound : 'original';
    for (const track of score.tracks) {
      if (isPercussionTrack(track)) continue;
      const info = soundInfo(track);
      let program = null;   // null keeps what the file says
      let bank = 0;
      if (info.isUkulele) {
        if (choice === 'original' || choice === 'ukulele') { program = 24; bank = UKULELE_BANK; }
        else program = GUITAR_SOUNDS[choice].program;
      } else if (info.isGuitar && choice !== 'original') {
        program = GUITAR_SOUNDS[choice].program;
        if (choice === 'ukulele') bank = UKULELE_GUITAR_BANK;
      }
      track.playbackInfo.program = program === null ? info.program : program;
      track.playbackInfo.bank = bank;
      for (const [automation, value] of info.instruments) automation.value = program === null ? value : program;
      // Bank changes inside the song must agree with the chosen bank, or they would switch the preset back.
      // Banks other than the ones above do not exist in the sound bank and would leave the track silent.
      for (const automation of info.banks) automation.value = bank;
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
    const count = state.score.tracks.filter(hasChangeableSound).length;
    toast(count ? `Sound: ${GUITAR_SOUNDS[value].label}` : 'This song has no guitar or ukulele tracks to change.');
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
  // Describes the song that is being handed to alphaTab; read again when its scoreLoaded event arrives.
  const pending = { key: null, name: '', bytes: null, saveToLibrary: false, practice: null, songId: null, tick: 0, scrollTop: 0, scrollLeft: 0, restoreScroll: false };

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

  function fileExtension(name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function isMuseScoreFile(name) {
    return !!window.ScoreMuseScore && window.ScoreMuseScore.isMuseScoreName(name);
  }

  // Drop anything that still points at the previous song before a new one is loaded.
  function resetForNewScore() {
    const api = state.api;
    if (!api) return;
    // Set first: clearing the range below fires playbackRangeChanged, which must not save over the old song.
    state.awaitMidi = true;
    state.awaitRender = true;
    state.rehighlightAfterRender = false;
    neutralizeHighlight();
    api.playbackRange = null;
    setLoop(false, true);
    lastBarTick = -1;
    lastTempo = { original: 0, modified: 0 };
  }

  // Tracks to render right away (saved practice state or the first track), so the first render is the final one.
  function initialTrackIndexes(score) {
    const p = pending.practice;
    const count = score ? score.tracks.length : Infinity;
    if (p && Array.isArray(p.visible) && p.visible.length) {
      const wanted = p.visible.filter((i) => i < count).sort((a, b) => a - b);
      if (wanted.length) return wanted;
    }
    return [0];
  }

  // Guitar Pro and MusicXML: parse on the main thread first so the text encoding can be picked before
  // alphaTab renders anything. Returns null when no importer understands the bytes.
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

  // MuseScore files are translated to MusicXML in the browser (js/musescore.js), then read by alphaTab.
  async function parseMuseScore(bytes, name) {
    const xml = await window.ScoreMuseScore.toMusicXml(bytes, name);   // throws with a message for the user
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), state.api.settings);
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        // MusicXML puts the string count in staff-lines, which alphaTab also uses for the notation staff.
        if (!staff.isPercussion && staff.tuning && staff.tuning.length) staff.standardNotationLineCount = 5;
      }
    }
    return score;
  }

  // Multi-line credits (common in Guitar Pro files) are drawn as one line by alphaTab and overlap.
  function tidyScoreText(score) {
    for (const key of ['title', 'subTitle', 'artist', 'album', 'words', 'music', 'wordsAndMusic', 'copyright', 'copyright2', 'tab', 'instructions', 'notices']) {
      const value = score[key];
      if (typeof value === 'string' && /[\r\n]/.test(value)) {
        score[key] = value.split(/\s*[\r\n]+\s*/).filter(Boolean).join(' · ');
      }
    }
    return score;
  }

  async function parseSong(bytes, name) {
    const score = isMuseScoreFile(name) ? await parseMuseScore(bytes, name) : parseScore(bytes, name);
    return score ? tidyScoreText(score) : null;
  }

  // Hands one tab's song to alphaTab. Parsed songs are kept on the tab, so switching back is instant.
  async function loadTabSong(tab) {
    const token = ++state.loadToken;
    pending.key = tab.key;
    pending.name = tab.name;
    pending.bytes = tab.bytes;
    pending.songId = tab.isDemo ? null : tab.key;
    pending.saveToLibrary = !tab.isDemo;
    pending.practice = tab.practice || null;
    pending.tick = tab.tick || 0;
    pending.scrollTop = tab.scrollTop || 0;
    pending.scrollLeft = tab.scrollLeft || 0;
    pending.restoreScroll = true;
    showLoading('Opening ' + tabLabel(tab));

    let score = tab.score;
    if (!score && !tab.isDemo) {
      let problem = '';
      try {
        score = await parseSong(tab.bytes, tab.name);
        if (!score) problem = 'This file type is not supported.';
      } catch (e) {
        console.warn('[Score] could not read', tab.name, e && e.message ? e.message : e);
        problem = e && e.message ? e.message : 'This file could not be read.';
        score = null;
      }
      if (token !== state.loadToken) return;   // another tab was picked in the meantime
      if (!score) { failTab(tab, problem); return; }
    }

    state.fileName = tab.name;
    state.isDemo = !!tab.isDemo;
    resetForNewScore();
    useBarsPerRow(pending.practice && pending.practice.barsPerRow);
    try {
      if (score) state.api.load(score, initialTrackIndexes(score));
      else state.api.tex(DEMO_TEX);
    } catch (e) {
      console.error('[Score] could not open', tab.name, e);
      failTab(tab, 'Something went wrong while opening this file.');
    }
  }

  function openDemo() {
    let tab = findTab(DEMO_KEY);
    if (!tab) {
      tab = newTab({ key: DEMO_KEY, name: 'Demo Riff', title: 'Demo Riff', isDemo: true });
      tabs.push(tab);
    }
    activateTab(tab.key);
  }

  function openLibrarySong(record) {
    let tab = findTab(record.id);
    if (!tab) {
      tab = tabFromRecord(record);
      tabs.push(tab);
    }
    activateTab(tab.key);
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
    state.loadedKey = pending.key;
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

    // Keep the parsed song on its tab for instant switching
    const tab = findTab(pending.key);
    let firstTime = true;
    if (tab) {
      firstTime = !tab.shown;
      tab.shown = true;
      tab.score = score;
      tab.title = score.title || '';
      tab.artist = score.artist || '';
      tab.lastUsed = Date.now();
      pruneScoreCache();
      renderTabBar();
    }
    if (firstTime) toast(`Loaded ${title}: ${score.tracks.length} track${score.tracks.length === 1 ? '' : 's'}, ${score.masterBars.length} bars`);
  }

  // Applied once the new score is both rendered (bounds exist) and its midi is ready (tick cache exists)
  function maybeApplyPractice() {
    if (state.awaitMidi || state.awaitRender) return;
    const practice = pending.practice;
    const tick = pending.tick;
    const scroll = pending.restoreScroll ? { top: pending.scrollTop, left: pending.scrollLeft } : null;
    pending.practice = null;
    pending.tick = 0;
    pending.scrollTop = 0;
    pending.scrollLeft = 0;
    pending.restoreScroll = false;
    if (!state.score) return;
    if (practice && practice.loopStart && practice.loopEnd) {
      setLoopBars(practice.loopStart, practice.loopEnd, false);
    }
    if (tick > 0) {
      try { state.api.tickPosition = tick; } catch (e) { /* the position is a convenience only */ }
    }
    if (scroll) {
      // A new song starts at the top (with its title), a tab you come back to where you left it.
      // alphaTab may still be easing towards its cursor, so the position is set once more after that.
      const token = state.loadToken;
      const apply = () => {
        if (token !== state.loadToken || app.classList.contains('playing')) return;
        els.viewport.scrollTop = scroll.top;
        els.viewport.scrollLeft = scroll.left;
      };
      apply();
      setTimeout(apply, 450);
    }
  }

  /* ---------------------------------------------------------------------
     Tabs: every opened song gets a tab above the sheet. Each tab keeps its own speed, loop, mix,
     bars per row, position and scroll, and the open tabs come back on the next visit.
  --------------------------------------------------------------------- */
  const tabs = [];
  let activeKey = null;

  function findTab(key) {
    return key ? tabs.find((t) => t.key === key) || null : null;
  }

  function newTab(fields) {
    return Object.assign({
      key: null, name: '', title: '', artist: '', bytes: null, score: null, practice: null,
      tick: 0, scrollTop: 0, scrollLeft: 0, isDemo: false, shown: false, lastUsed: 0,
    }, fields);
  }

  function tabFromRecord(record) {
    // The library stores an ArrayBuffer; everything else in Score works with a Uint8Array view of it.
    const bytes = record.data instanceof Uint8Array ? record.data : new Uint8Array(record.data);
    return newTab({
      key: record.id, name: record.name, title: record.title || '', artist: record.artist || '',
      bytes, practice: record.practice || null,
    });
  }

  function tabLabel(tab) {
    return tab.title || (tab.name || '').replace(/\.[^.]+$/, '') || 'Untitled';
  }

  function tabFormat(tab) {
    if (tab.isDemo) return 'DEMO';
    const ext = fileExtension(tab.name);
    return ext === 'musicxml' ? 'XML' : ext.toUpperCase();
  }

  function currentPractice() {
    return {
      speed: state.speed,
      loopStart: state.loopStartBar,
      loopEnd: state.loopEndBar,
      visible: [...state.visible],
      mute: [...state.mute],
      solo: [...state.solo],
      volume: Object.fromEntries([...state.volume.entries()]),
      barsPerRow: state.barsPerRow,
    };
  }

  // Remembers where the song on screen was left, so its tab opens exactly there again.
  function snapshotLoadedTab() {
    const tab = findTab(state.loadedKey);
    if (!tab || !state.score || !state.api) return;
    if (state.awaitMidi || state.awaitRender) return;   // still loading: its stored state was never applied
    tab.practice = currentPractice();
    try { tab.tick = state.api.tickPosition || 0; } catch (e) { tab.tick = 0; }
    tab.scrollTop = els.viewport.scrollTop;
    tab.scrollLeft = els.viewport.scrollLeft;
  }

  async function activateTab(key) {
    const tab = findTab(key);
    if (!tab) return;
    if (key === state.loadedKey && state.score) {
      state.loadToken++;   // a slower load of another tab must not replace this one
      activeKey = key;
      hideLoading();
      renderTabBar();
      persistTabs();
      return;
    }
    flushPracticeSave();
    snapshotLoadedTab();
    if (state.api && state.score) { try { state.api.stop(); } catch (e) { /* ignore */ } }
    activeKey = key;
    tab.lastUsed = Date.now();
    renderTabBar();
    persistTabs();
    await loadTabSong(tab);
  }

  function closeTab(key) {
    const index = tabs.findIndex((t) => t.key === key);
    if (index < 0) return;
    if (key === state.loadedKey) flushPracticeSave();
    tabs.splice(index, 1);
    if (key === activeKey) {
      activeKey = null;
      const next = tabs[index] || tabs[index - 1];
      if (next) activateTab(next.key);
      else showEmptyState();
    }
    renderTabBar();
    persistTabs();
  }

  function cycleTab(step) {
    if (tabs.length < 2) return;
    const index = Math.max(0, tabs.findIndex((t) => t.key === activeKey));
    activateTab(tabs[(index + step + tabs.length) % tabs.length].key);
  }

  // A song that cannot be opened loses its tab, and the song that was showing before stays on screen.
  function failTab(tab, message) {
    hideLoading();
    toast(message || 'This file could not be opened.', true);
    const index = tabs.indexOf(tab);
    if (index >= 0) tabs.splice(index, 1);
    if (!tab.isDemo && tab.key) {
      // Files that never opened do not belong in the library
      dbGet(tab.key).then((rec) => { if (rec && !rec.bars) return dbDelete(tab.key); }).catch(() => {});
    }
    activeKey = findTab(state.loadedKey) ? state.loadedKey : null;
    if (!activeKey) {
      if (tabs.length) activateTab(tabs[Math.min(index, tabs.length - 1)].key);
      else showEmptyState();
    }
    renderTabBar();
    persistTabs();
  }

  function showEmptyState() {
    state.loadToken++;   // drop a load that is still running
    flushPracticeSave();
    state.songId = null;  // before the range is cleared below, so nothing is saved over the closed song
    if (state.api) {
      try { state.api.stop(); } catch (e) { /* ignore */ }
      neutralizeHighlight();
      try { state.api.playbackRange = null; } catch (e) { /* ignore */ }
    }
    state.score = null;
    state.loadedKey = null;
    state.isDemo = false;
    state.fileName = '';
    pending.key = null;
    pending.practice = null;
    state.loopStartBar = null;
    state.loopEndBar = null;
    setLoop(false, true);
    app.classList.add('no-song');
    app.classList.remove('playing');
    els.songMeta.hidden = true;
    document.title = 'Score';
    els.trackList.innerHTML = '';
    els.loopStart.value = '';
    els.loopEnd.value = '';
    els.barIndicator.textContent = 'Bar -';
    els.progress.value = 0;
    els.timeCurrent.textContent = '0:00';
    els.timeTotal.textContent = '0:00';
    els.bpmValue.textContent = '';
    hideLoading();
    updatePlayEnabled();
  }

  // Parsed songs take memory; keep only the most recently used ones (the others are parsed again on demand).
  function pruneScoreCache() {
    const cached = tabs.filter((t) => t.score && t.key !== state.loadedKey).sort((a, b) => b.lastUsed - a.lastUsed);
    cached.slice(MAX_CACHED_SCORES - 1).forEach((t) => { t.score = null; });
  }

  function persistTabs() {
    settings.openTabs = tabs.map((t) => t.key);
    settings.activeTab = activeKey;
    saveSettings();
  }

  function renderTabBar() {
    els.tabBar.hidden = tabs.length === 0;
    app.classList.toggle('has-tabs', tabs.length > 0);
    els.tabList.innerHTML = '';
    for (const tab of tabs) {
      const active = tab.key === activeKey;
      const el = document.createElement('div');
      el.className = 'tab' + (active ? ' active' : '');
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', active ? 'true' : 'false');
      el.tabIndex = 0;
      el.dataset.key = tab.key;
      el.title = tabLabel(tab) + (tab.artist ? ' by ' + tab.artist : '') + (tab.isDemo ? '' : '\n' + tab.name);

      const fmt = document.createElement('span');
      fmt.className = 'tab-fmt';
      fmt.textContent = tabFormat(tab);
      const label = document.createElement('span');
      label.className = 'tab-title';
      label.textContent = tabLabel(tab);
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.tabIndex = -1;
      close.title = 'Close tab';
      close.setAttribute('aria-label', 'Close ' + tabLabel(tab));
      close.innerHTML = '&times;';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.key); });

      el.addEventListener('click', () => activateTab(tab.key));
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.key); } });
      el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // no autoscroll on middle click
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); activateTab(tab.key); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); closeTab(tab.key); }
      });
      el.append(fmt, label, close);
      els.tabList.appendChild(el);
    }
    const current = els.tabList.querySelector('.tab.active');
    if (current) {
      const list = els.tabList;
      if (current.offsetLeft < list.scrollLeft) list.scrollLeft = current.offsetLeft - 8;
      else if (current.offsetLeft + current.offsetWidth > list.scrollLeft + list.clientWidth) {
        list.scrollLeft = current.offsetLeft + current.offsetWidth - list.clientWidth + 8;
      }
    }
  }

  // Reads picked or dropped files into tabs (a file that is already open just gets its tab back).
  async function addFileTab(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await hashBytes(bytes, file.name);
    const open = findTab(id);
    if (open) return open;
    const existing = await dbGet(id).catch(() => null);
    // The same file name with new content (after editing it in Guitar Pro or MuseScore) replaces its old tab.
    let tab = tabs.find((t) => !t.isDemo && t.name.toLowerCase() === file.name.toLowerCase());
    if (tab) {
      if (tab.key === state.loadedKey) { snapshotLoadedTab(); state.loadedKey = null; }
      tab.key = id;
      tab.bytes = bytes;
      tab.score = null;
      tab.shown = false;
      if (!tab.practice && existing && existing.practice) tab.practice = existing.practice;
    } else {
      tab = newTab({
        key: id, name: file.name, bytes,
        title: existing ? existing.title || '' : '',
        artist: existing ? existing.artist || '' : '',
        practice: existing && existing.practice ? existing.practice : null,
      });
      tabs.push(tab);
    }
    // In the library right away, so the tab comes back after a reload even if it was never opened.
    await dbPut({
      id, name: file.name, title: tab.title, artist: tab.artist, size: bytes.byteLength,
      added: Date.now(), opened: Date.now(), data: bytes.slice().buffer, practice: tab.practice,
    }, true).catch(() => { /* storage may be unavailable */ });
    return tab;
  }

  async function openFiles(files) {
    let first = null;
    for (const file of files) {
      showLoading('Reading ' + file.name);
      try {
        const tab = await addFileTab(file);
        if (!first) first = tab;
      } catch (e) {
        toast('Could not read ' + file.name, true);
      }
    }
    hideLoading();
    renderTabBar();
    persistTabs();
    if (first) {
      activateTab(first.key);
      if (files.length > 1) setTimeout(() => toast(`${files.length} files open as tabs. Switch with Shift + arrow keys.`), 1200);
    }
  }

  // Brings back the tabs of the last visit (from the library, so this also works offline).
  async function restoreTabs() {
    const keys = Array.isArray(settings.openTabs) ? settings.openTabs.slice(0, 40) : [];
    if (!keys.length) return;
    for (const key of keys) {
      if (findTab(key)) continue;
      if (key === DEMO_KEY) {
        tabs.push(newTab({ key: DEMO_KEY, name: 'Demo Riff', title: 'Demo Riff', isDemo: true }));
        continue;
      }
      const record = await dbGet(key).catch(() => null);
      if (record && record.data) tabs.push(tabFromRecord(record));
    }
    if (activeKey) { renderTabBar(); persistTabs(); return; }   // the user already opened something meanwhile
    renderTabBar();
    const first = findTab(settings.activeTab) || tabs[0];
    if (first) activateTab(first.key);
    else persistTabs();
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
    if (info.bank === UKULELE_BANK || info.bank === UKULELE_GUITAR_BANK) return 'ukulele';
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
    showBarsPerRow();
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

  // Bars per row: Auto (-1) lets alphaTab fit the width; a number fixes every row of the page layout.
  // The choice is stored with each song, because only busy songs need fewer bars per row.
  const BARS_CHOICES = [-1, 1, 2, 3, 4, 5, 6];

  function normalizeBars(value) {
    const n = Number(value);
    return BARS_CHOICES.includes(n) ? n : -1;
  }

  function showBarsPerRow() {
    const horizontal = settings.layout === 'horizontal';
    els.segBars.classList.toggle('disabled', horizontal);
    els.segBars.title = horizontal ? 'Bars per row applies to the Page layout' : '';
    els.segBars.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.value) === state.barsPerRow);
      b.disabled = horizontal;
    });
  }

  // Sets the value without drawing; the next render uses it.
  function useBarsPerRow(value) {
    state.barsPerRow = normalizeBars(value);
    showBarsPerRow();
    if (state.api) {
      state.api.settings.display.barsPerRow = state.barsPerRow;
      state.api.updateSettings();
    }
  }

  function setBarsPerRow(value) {
    const before = state.barsPerRow;
    useBarsPerRow(value);
    if (state.barsPerRow === before) return;
    if (state.score && settings.layout === 'page') {
      // the loop highlight belongs to the old layout: park it and draw it again afterwards
      if (state.loopStartBar) { neutralizeHighlight(); state.rehighlightAfterRender = true; }
      state.api.render();
    }
    schedulePracticeSave();
    toast(state.barsPerRow > 0 ? `${state.barsPerRow} bar${state.barsPerRow === 1 ? '' : 's'} per row` : 'Bars per row: Auto');
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
  // While a song is loading, the state on screen is half old and half new, so nothing is saved then.
  function schedulePracticeSave() {
    if (!state.songId || state.awaitMidi || state.awaitRender) return;
    clearTimeout(state.practiceSaveTimer);
    state.practiceSaveTimer = setTimeout(savePractice, 600);
  }

  // Saves a pending change right now (before switching tabs or closing one).
  function flushPracticeSave() {
    if (!state.practiceSaveTimer) return;
    clearTimeout(state.practiceSaveTimer);
    state.practiceSaveTimer = null;
    savePractice();
  }

  async function savePractice() {
    state.practiceSaveTimer = null;
    if (!state.songId || state.awaitMidi || state.awaitRender) return;
    const songId = state.songId;
    const practice = currentPractice();
    const tab = findTab(songId);
    if (tab) tab.practice = practice;
    try {
      const rec = await dbGet(songId);
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
        for (const key of ['title', 'artist', 'tracks', 'bars']) {
          if (!record[key] && existing[key]) record[key] = existing[key];
        }
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
      if (findTab(rec.id)) {
        const badge = document.createElement('span');
        badge.className = 'li-open';
        badge.textContent = rec.id === activeKey ? 'showing' : 'open in a tab';
        title.appendChild(badge);
      }
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
        // Removing a song from this device also closes its tab
        if (findTab(rec.id)) {
          if (rec.id === state.loadedKey) { clearTimeout(state.practiceSaveTimer); state.practiceSaveTimer = null; state.songId = null; }
          closeTab(rec.id);
        }
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
    return /\.(gp|gpx|gp3|gp4|gp5|mscz|mscx|xml|musicxml|mxl|capx)$/i.test(name || '');
  }

  // Every supported file opens in its own tab; the first one is shown.
  async function handleFiles(fileList) {
    const all = [...fileList];
    const files = all.filter((f) => isSupportedName(f.name));
    if (!files.length) {
      toast('Score opens Guitar Pro files (.gp, .gpx, .gp3, .gp4, .gp5) and MuseScore files (.mscz, .mscx).', true);
      return;
    }
    if (files.length < all.length) {
      const skipped = all.length - files.length;
      setTimeout(() => toast(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped (not a Guitar Pro, MuseScore or MusicXML file).`, true), 2800);
    }
    await openFiles(files);
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

  // iPhone and iPad only understand file types they know. .gp, .gp5, .mscz and friends are unknown to iOS,
  // so with an accept list the picker greys them all out (only .xml stays selectable). On those devices the
  // picker shows every file instead, and handleFiles() still checks the names and explains anything it skips.
  const isAppleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS reports itself as a Mac
  if (isAppleTouch) els.fileInput.removeAttribute('accept');

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
      const files = [];
      for (const handle of params.files) {
        try { files.push(await handle.getFile()); } catch (e) { /* skip */ }
      }
      if (files.length) handleFiles(files);
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
  els.segBars.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setBarsPerRow(b.dataset.value)));
  $('btnTabAdd').addEventListener('click', () => els.fileInput.click());
  els.tabList.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || els.tabList.scrollWidth <= els.tabList.clientWidth) return;
    e.preventDefault();
    els.tabList.scrollLeft += e.deltaY;
  }, { passive: false });
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
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      cycleTab(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }

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

    if (!GUITAR_SOUNDS[settings.guitarSound]) settings.guitarSound = 'original';
    document.querySelectorAll('#segSound button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.guitarSound));
    els.btnReverb.setAttribute('aria-pressed', settings.reverb ? 'true' : 'false');
    showBarsPerRow();

    if (typeof alphaTab === 'undefined') {
      toast('alphaTab failed to load. Serve Score over http(s), not from file://', true);
      return;
    }
    installOutputChain();
    createApi();
    updatePlayEnabled();
    loadSounds();
    restoreTabs().catch((e) => console.warn('[Score] open tabs could not be restored', e));
    console.info('[Score] v' + APP_VERSION + ' using alphaTab ' + (alphaTab.meta ? alphaTab.meta.version : ''));
  }

  boot();

  // Expose a tiny debug handle (handy in the console, harmless otherwise)
  window.Score = {
    get api() { return state.api; },
    get state() { return state; },
    get tabs() { return tabs; },
    get activeTab() { return activeKey; },
    setLoopBars, clearLoop, setSpeed, openDemo, setGuitarSound, setReverb, setBarsPerRow, activateTab, closeTab, cycleTab,
    fx, version: APP_VERSION,
  };
})();
