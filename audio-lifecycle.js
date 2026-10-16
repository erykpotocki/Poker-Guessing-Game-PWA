/* Game audio belongs to the visible app, never to a background music player.
   Install before Unity creates its Web Audio context. */
(() => {
  'use strict';
  const entries = new Map();
  const playingMedia = new Set();
  const mediaToResume = new Map();
  const mediaIntent = new WeakMap();
  let pauseMedia = element => safely(() => element.pause());
  let resumeMedia = () => {};
  let blurred = false, pageHidden = false, frozen = false;
  const blocked = () => document.hidden || blurred || pageHidden || frozen;
  const safely = action => { try { const p = action(); if (p && p.catch) p.catch(() => {}); } catch (_) {} };
  function ambient() {
    safely(() => { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; });
  }
  function clearPlayer() {
    const session = navigator.mediaSession;
    if (!session) return;
    safely(() => { session.metadata = null; });
    safely(() => { session.playbackState = 'none'; });
    for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'])
      safely(() => session.setActionHandler(action, null));
    safely(() => session.setPositionState());
  }
  function silence(context, entry) {
    entry.wantResume ||= context.state === 'running' || context.state === 'interrupted';
    // Mute synchronously, even if suspend() is delayed/rejected by the host.
    if (entry.gate) entry.gate.gain.value = 0;
    if (context.state !== 'closed' && !entry.suspending) {
      entry.suspending = true;
      try { Promise.resolve(context.suspend()).catch(() => {}).finally(() => { entry.suspending = false; }); }
      catch (_) { entry.suspending = false; }
    }
  }
  function restore(context, entry) {
    if (blocked() || context.state === 'closed') return;
    if (entry.gate) entry.gate.gain.value = 1;
    if (entry.wantResume && context.state !== 'running') safely(() => entry.resume.call(context));
    if (context.state === 'running') entry.wantResume = false;
  }
  const node = window.AudioNode && window.AudioNode.prototype;
  if (node) {
    const connect = node.connect, disconnect = node.disconnect;
    node.connect = function(...args) {
      const entry = entries.get(this.context);
      const destination = args[0];
      if (entry && entry.gate && this !== entry.gate && args[0] === this.context.destination) args[0] = entry.gate;
      const result = connect.apply(this, args);
      return result === args[0] ? destination : result;
    };
    node.disconnect = function(...args) {
      const entry = entries.get(this.context);
      if (entry && entry.gate && this !== entry.gate && args[0] === this.context.destination) args[0] = entry.gate;
      return disconnect.apply(this, args);
    };
  }
  // Patch each distinct prototype once; Safari may expose both constructor names.
  const installed = new Set();
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name];
    if (!Native) continue;
    const prototype = Native.prototype;
    if (!installed.has(prototype)) {
      installed.add(prototype);
      const resume = prototype.resume;
      prototype.resume = function(...args) {
        const entry = entries.get(this);
        if (blocked()) { if (entry) silence(this, entry); return Promise.resolve(); }
        return resume.apply(this, args);
      };
    }
    window[name] = new Proxy(Native, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget);
        const entry = { gate: null, resume: prototype.resume, wantResume: false, suspending: false };
        // The gate itself connects before registration, directly to the real output.
        if (node) safely(() => { const gate = context.createGain(); gate.connect(context.destination); entry.gate = gate; });
        entries.set(context, entry);
        context.addEventListener('statechange', () => {
          if (context.state === 'closed') { entries.delete(context); return; }
          if (blocked()) { silence(context, entry); clearPlayer(); }
          else restore(context, entry);
        });
        if (blocked()) silence(context, entry);
        return context;
      }
    });
  }
  // Cover HTML media too, including elements not yet attached to the document.
  const media = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (media) {
    const play = media.play, pause = media.pause;
    const intent = element => {
      let value = mediaIntent.get(element);
      if (!value) { value = { version: 0, action: 'play' }; mediaIntent.set(element, value); }
      return value;
    };
    pauseMedia = (element, remember = false) => {
      if (remember && !element.paused && !element.ended && !mediaToResume.has(element))
        mediaToResume.set(element, { version: intent(element).version, src: element.src, pending: false });
      safely(() => pause.call(element));
    };
    media.pause = function(...args) {
      const value = intent(this);
      value.version++; value.action = 'pause';
      mediaToResume.delete(this); playingMedia.delete(this);
      return pause.apply(this, args);
    };
    media.play = function(...args) {
      const value = intent(this);
      value.version++; value.action = 'play';
      mediaToResume.delete(this);
      if (blocked()) { pauseMedia(this); clearPlayer(); return Promise.resolve(); }
      const version = value.version;
      playingMedia.add(this);
      const result = play.apply(this, args);
      // Detached streaming elements also need protection from a late play().
      if (result && result.then) result.then(() => {
        if (blocked()) { pauseMedia(this, intent(this).version === version); clearPlayer(); }
      }, () => {});
      return result;
    };
    resumeMedia = () => {
      for (const [element, entry] of mediaToResume) {
        if (blocked()) return;
        if (entry.pending) continue;
        const value = intent(element);
        if (value.version !== entry.version || element.src !== entry.src || element.ended) { mediaToResume.delete(element); continue; }
        entry.pending = true;
        playingMedia.add(element);
        const completed = () => {
          entry.pending = false;
          const latest = intent(element);
          if (blocked()) { pauseMedia(element); clearPlayer(); }
          else if (latest.version !== entry.version && latest.action === 'pause') pauseMedia(element);
          else if (mediaToResume.get(element) === entry) mediaToResume.delete(element);
        };
        const rejected = () => { entry.pending = false; };
        try {
          const result = play.call(element);
          if (result && result.then) result.then(completed, rejected);
          else completed();
        } catch (_) { rejected(); }
      }
    };
  }
  function update() {
    if (blocked()) {
      for (const [context, entry] of entries) silence(context, entry);
      for (const element of playingMedia) pauseMedia(element, true);
      playingMedia.clear();
      for (const element of document.querySelectorAll('audio,video')) pauseMedia(element, true);
      clearPlayer();
    } else {
      ambient();
      for (const [context, entry] of entries) restore(context, entry);
      // Unity handles AudioContext suspension asynchronously. Its media-backed
      // channels can already be paused when that event reaches the engine, so
      // remember and restore only the elements this lifecycle itself paused.
      resumeMedia();
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) blurred = false; update(); });
  window.addEventListener('blur', () => { blurred = true; update(); });
  window.addEventListener('focus', () => { blurred = false; update(); });
  window.addEventListener('pagehide', () => { pageHidden = true; update(); });
  window.addEventListener('pageshow', () => { pageHidden = false; blurred = false; update(); });
  document.addEventListener('freeze', () => { frozen = true; update(); });
  document.addEventListener('resume', () => { frozen = false; update(); });
  document.addEventListener('play', event => {
    if (blocked()) { pauseMedia(event.target); clearPlayer(); }
    else playingMedia.add(event.target);
  }, true);
  // A rejected foreground resume can require the next user gesture on iOS.
  for (const event of ['pointerdown', 'touchstart', 'keydown']) document.addEventListener(event, update, { capture: true, passive: true });
  ambient();
  clearPlayer();
  update();
})();
