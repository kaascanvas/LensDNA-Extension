/**
 * LensDNA Meet mix — MAIN world
 * Out: wrap getUserMedia + RTCPeerConnection so Nexus TTS rides the Meet mic.
 * In: tap Meet playback (captureStream on audio/video) and relay PCM to the side panel.
 * Default: both directions off until the operator arms 🎧.
 */
(function () {
  if (window.__lensdnaMeetMix) return;

  const state = {
    injectionActive: false,
    listenActive: false,
    audioCtx: null,
    dest: null,
    micSource: null,
    micGain: null,
    ttsGain: null,
    nextTts: 0,
    originalGUM: null,
    lastConstraints: null,
    rawMicStream: null,
    tapCtx: null,
    tapDest: null,
    tapNode: null,
    tapSources: new Map(),
    tapObserver: null,
  };

  window.__lensdnaMeetMix = state;

  function ensureGraph() {
    if (state.audioCtx) return state;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx({ sampleRate: 48000 });
    state.dest = state.audioCtx.createMediaStreamDestination();
    state.micGain = state.audioCtx.createGain();
    state.ttsGain = state.audioCtx.createGain();
    state.micGain.gain.value = 1;
    state.ttsGain.gain.value = 0;
    state.micGain.connect(state.dest);
    state.ttsGain.connect(state.dest);
    state.nextTts = 0;
    return state;
  }

  function attachMic(stream) {
    ensureGraph();
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;
    if (state.micSource) {
      try { state.micSource.disconnect(); } catch (_) {}
    }
    state.rawMicStream = new MediaStream(audioTracks);
    state.micSource = state.audioCtx.createMediaStreamSource(state.rawMicStream);
    state.micSource.connect(state.micGain);
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }
  }

  function mixedStreamFrom(original) {
    ensureGraph();
    attachMic(original);
    const mixed = new MediaStream();
    state.dest.stream.getAudioTracks().forEach((t) => mixed.addTrack(t));
    original.getVideoTracks().forEach((t) => mixed.addTrack(t));
    return mixed;
  }

  function replacePeerAudioSenders() {
    const mixedTrack = state.dest && state.dest.stream.getAudioTracks()[0];
    if (!mixedTrack) return 0;
    let n = 0;
    const bag = window.__lensdnaPcs;
    if (!bag) return 0;
    bag.forEach((pc) => {
      try {
        (pc.getSenders ? pc.getSenders() : []).forEach((sender) => {
          if (sender.track && sender.track.kind === 'audio') {
            sender.replaceTrack(mixedTrack).catch(() => {});
            n += 1;
          }
        });
      } catch (_) {}
    });
    return n;
  }

  if (!window.__lensdnaPcs) {
    window.__lensdnaPcs = new Set();
    const OrigPC = window.RTCPeerConnection;
    if (OrigPC) {
      window.RTCPeerConnection = function (...args) {
        const pc = new OrigPC(...args);
        window.__lensdnaPcs.add(pc);
        const origClose = pc.close.bind(pc);
        pc.close = function (...cargs) {
          window.__lensdnaPcs.delete(pc);
          return origClose(...cargs);
        };
        return pc;
      };
      window.RTCPeerConnection.prototype = OrigPC.prototype;
      Object.getOwnPropertyNames(OrigPC).forEach((key) => {
        if (key === 'prototype' || key === 'name' || key === 'length') return;
        try {
          window.RTCPeerConnection[key] = OrigPC[key];
        } catch (_) {}
      });
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    state.originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      state.lastConstraints = constraints;
      const stream = await state.originalGUM(constraints);
      const wantsAudio = !constraints || constraints.audio;
      if (!wantsAudio) return stream;
      return mixedStreamFrom(stream);
    };
  }

  function playPcm16Base64(b64, sampleRate) {
    if (!state.injectionActive) return;
    ensureGraph();
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }
    let raw;
    try {
      raw = atob(b64);
    } catch (_) {
      return;
    }
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (bytes.byteLength < 2) return;
    const aligned = bytes.byteOffset % 2 === 0 ? bytes : bytes.slice();
    const pcm16 = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2));
    const f32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
    const rate = sampleRate || 16000;
    const buf = state.audioCtx.createBuffer(1, f32.length, rate);
    buf.copyToChannel(f32, 0);
    const src = state.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(state.ttsGain);
    const now = state.audioCtx.currentTime;
    if (state.nextTts < now + 0.02) state.nextTts = now;
    src.start(state.nextTts);
    state.nextTts += buf.duration;
  }

  function int16ToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function attachMediaEl(el) {
    if (!state.listenActive || !state.tapCtx) return;
    if (!(el instanceof HTMLMediaElement)) return;
    if (state.tapSources.has(el)) return;
    try {
      if (typeof el.captureStream !== 'function') return;
      const stream = el.captureStream();
      if (!stream.getAudioTracks().length) {
        const onMeta = () => {
          try {
            const s2 = el.captureStream();
            if (s2.getAudioTracks().length && !state.tapSources.has(el)) {
              const src = state.tapCtx.createMediaStreamSource(s2);
              src.connect(state.tapDest);
              state.tapSources.set(el, src);
            }
          } catch (_) {}
        };
        el.addEventListener('playing', onMeta, { once: true });
        return;
      }
      const src = state.tapCtx.createMediaStreamSource(stream);
      src.connect(state.tapDest);
      state.tapSources.set(el, src);
    } catch (_) {}
  }

  function scanMedia() {
    document.querySelectorAll('audio, video').forEach(attachMediaEl);
  }

  async function startListenTap() {
    if (state.tapCtx) {
      state.listenActive = true;
      scanMedia();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.tapCtx = new Ctx({ sampleRate: 48000 });
    state.tapDest = state.tapCtx.createMediaStreamDestination();
    const workletSrc = `
      class LensdnaMeetTap extends AudioWorkletProcessor {
        constructor() {
          super();
          this._acc = [];
          this._frames = 0;
          this._target = Math.max(1, Math.round(sampleRate * 0.1));
        }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (!ch) return true;
          const step = sampleRate / 16000;
          for (let i = 0; i < ch.length; i += step) {
            this._acc.push(ch[Math.floor(i)] || 0);
          }
          this._frames += ch.length;
          if (this._frames >= this._target && this._acc.length) {
            const out = new Int16Array(this._acc.length);
            let peak = 0;
            for (let i = 0; i < this._acc.length; i++) {
              const s = Math.max(-1, Math.min(1, this._acc[i]));
              out[i] = s < 0 ? s * 32768 : s * 32767;
              const a = Math.abs(s);
              if (a > peak) peak = a;
            }
            if (peak > 0.012) this.port.postMessage(out);
            this._acc = [];
            this._frames = 0;
          }
          return true;
        }
      }
      registerProcessor('lensdna-meet-tap', LensdnaMeetTap);
    `;
    const blob = new Blob([workletSrc], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await state.tapCtx.audioWorklet.addModule(url);
      state.tapNode = new AudioWorkletNode(state.tapCtx, 'lensdna-meet-tap');
      const tapSource = state.tapCtx.createMediaStreamSource(state.tapDest.stream);
      tapSource.connect(state.tapNode);
      state.tapNode.port.onmessage = (ev) => {
        if (!state.listenActive) return;
        const pcm = ev.data;
        if (!pcm || !pcm.length) return;
        window.postMessage(
          {
            __lensdna: 'meet-mix-playback',
            pcm: int16ToBase64(pcm),
            sampleRate: 16000,
          },
          '*'
        );
      };
    } catch (err) {
      console.warn('[LensDNA] Meet listen worklet failed', err);
    } finally {
      URL.revokeObjectURL(url);
    }

    state.listenActive = true;
    scanMedia();
    if (!state.tapObserver) {
      state.tapObserver = new MutationObserver(() => scanMedia());
      state.tapObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (state.tapCtx.state === 'suspended') {
      state.tapCtx.resume().catch(() => {});
    }
  }

  function stopListenTap() {
    state.listenActive = false;
    state.tapSources.forEach((src) => {
      try { src.disconnect(); } catch (_) {}
    });
    state.tapSources.clear();
  }

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || d.__lensdna !== 'meet-mix') return;

    if (d.cmd === 'setInjection') {
      state.injectionActive = !!d.on;
      ensureGraph();
      state.ttsGain.gain.value = state.injectionActive ? 0.9 : 0;
      if (state.injectionActive) {
        replacePeerAudioSenders();
        startListenTap();
      } else {
        stopListenTap();
      }
      window.postMessage(
        {
          __lensdna: 'meet-mix-status',
          injectionActive: state.injectionActive,
          listenActive: state.listenActive,
          sendersSwapped: state.injectionActive ? replacePeerAudioSenders() : 0,
        },
        '*'
      );
    }

    if (d.cmd === 'tts' && d.pcm) {
      playPcm16Base64(d.pcm, d.sampleRate);
    }

    if (d.cmd === 'ping') {
      window.postMessage(
        {
          __lensdna: 'meet-mix-status',
          injectionActive: state.injectionActive,
          listenActive: state.listenActive,
          hooked: true,
        },
        '*'
      );
    }
  });

  window.postMessage({ __lensdna: 'meet-mix-status', hooked: true, injectionActive: false, listenActive: false }, '*');
})();
