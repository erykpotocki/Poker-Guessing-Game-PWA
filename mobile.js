/* Scene-owned orientation. Rotate the viewport when OS locking is unavailable;
   never replace the game with a rotate-phone blocker. */
(() => {
  'use strict';
  const mobile = matchMedia('(pointer: coarse)').matches;
  const container = document.getElementById('unity-container');
  const canvas = document.getElementById('unity-canvas');
  if (!container || !canvas) return;
  const nativeCanvasBounds = canvas.getBoundingClientRect.bind(canvas);
  const safeProbe = document.createElement('div');
  safeProbe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(safeProbe);
  let desired = 'portrait', bootVisible = true;
  let logicalWidth = 1, logicalHeight = 1, rotation = 0;
  let lastViewport = null, pendingLock = null, lockedOrientation = null;
  let settleFrame = 0, settleUntil = 0;
  function settleViewport() {
    settleUntil = performance.now() + 650;
    if (settleFrame) return;
    function step() {
      refresh();
      settleFrame = performance.now() < settleUntil ? requestAnimationFrame(step) : 0;
    }
    settleFrame = requestAnimationFrame(step);
  }
  const isEditing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');

  // Unity uses this rect for render size AND input offset. CSS rotation alone
  // would swap the backing-buffer size and stretch the scene. Keep the physical
  // origin but expose logical dimensions. The bridge maps input to this origin.
  // All other DOM elements and browser hit-testing retain physical geometry.
  canvas.getBoundingClientRect = () => {
    const raw = nativeCanvasBounds();
    return new DOMRect(raw.left, raw.top, logicalWidth, logicalHeight);
  };

  function refresh() {
    const editing = isEditing();
    // The software keyboard must not be mistaken for a landscape device.
    const viewport = editing && lastViewport ? lastViewport : {
      width: Math.max(1, window.visualViewport?.width ?? window.innerWidth),
      height: Math.max(1, window.visualViewport?.height ?? window.innerHeight),
      x: window.visualViewport?.offsetLeft || 0,
      y: window.visualViewport?.offsetTop || 0
    };
    if (!editing) lastViewport = viewport;
    const wanted = bootVisible ? 'portrait' : desired;
    const wantsLandscape = wanted === 'landscape';
    const wrongAspect = (viewport.width > viewport.height) !== wantsLandscape;
    const safe = getComputedStyle(safeProbe);
    const left = parseFloat(safe.paddingLeft) || 0, right = parseFloat(safe.paddingRight) || 0;
    const top = parseFloat(safe.paddingTop) || 0, bottom = parseFloat(safe.paddingBottom) || 0;
    const availableWidth = Math.max(1, viewport.width - left - right);
    const availableHeight = Math.max(1, viewport.height - top - bottom);
    rotation = 0;
    if (mobile && wrongAspect) {
      const angle = screen.orientation?.angle ?? window.orientation ?? 0;
      // Menu counter-rotates the device. A landscape game on a portrait-locked
      // iPhone renders sideways, ready to turn and play, without blocking taps.
      rotation = wantsLandscape ? 90 : (angle === 270 || angle === -90 ? 90 : -90);
    }
    logicalWidth = rotation ? availableHeight : availableWidth;
    logicalHeight = rotation ? availableWidth : availableHeight;
    if (!mobile) {
      const ratio = wantsLandscape ? 16 / 9 : 9 / 16;
      logicalWidth = Math.min(logicalWidth, logicalHeight * ratio);
      logicalHeight = logicalWidth / ratio;
    }
    container.style.width = logicalWidth + 'px';
    container.style.height = logicalHeight + 'px';
    container.style.left = (viewport.x + left + availableWidth / 2) + 'px';
    container.style.top = (viewport.y + top + availableHeight / 2) + 'px';
    container.style.transform = 'translate(-50%, -50%) rotate(' + rotation + 'deg)';
    container.style.transition = 'none';
    container.style.setProperty('--view-width', logicalWidth + 'px');
    container.style.setProperty('--view-height', logicalHeight + 'px');
    container.dataset.orientation = wanted;
    const vv = window.visualViewport, area = nativeCanvasBounds();
    window.PokerMobile.keyboardFraction = editing && !rotation && vv && area.height > 0
      ? Math.max(0, Math.min(1, (area.bottom - vv.offsetTop - vv.height) / area.height)) : 0;
  }

  function tryLock() {
    if (!mobile || isEditing() || typeof screen.orientation?.lock !== 'function') return;
    const target = bootVisible ? 'portrait' : desired;
    if (pendingLock || lockedOrientation === target) return;
    // No forced fullscreen or permission dialog. The fallback is already active.
    const request = { target };
    pendingLock = request;
    try {
      Promise.resolve(screen.orientation.lock(target)).then(() => {
        lockedOrientation = target;
      }, () => { lockedOrientation = null; }).finally(() => {
        if (pendingLock === request) pendingLock = null;
        refresh();
        if (target !== (bootVisible ? 'portrait' : desired)) tryLock();
      });
    } catch (_) { pendingLock = null; lockedOrientation = null; }
  }

  function mapInputEvent(event) {
    if (!rotation || /^(INPUT|TEXTAREA)$/.test(event.target?.tagName || '')) return event;
    const rect = nativeCanvasBounds();
    if (!rect.width || !rect.height) return event;
    const point = value => {
      const x = rotation === 90 ? (value.clientY - rect.top) * logicalWidth / rect.height
        : (rect.bottom - value.clientY) * logicalWidth / rect.height;
      const y = rotation === 90 ? (rect.right - value.clientX) * logicalHeight / rect.width
        : (value.clientX - rect.left) * logicalHeight / rect.width;
      return { clientX: rect.left + x, clientY: rect.top + y,
        pageX: rect.left + x + window.scrollX, pageY: rect.top + y + window.scrollY };
    };
    const mapped = {};
    if (typeof event.clientX === 'number') {
      Object.assign(mapped, point(event));
      mapped.movementX = (rotation === 90 ? 1 : -1) * (event.movementY || 0) * logicalWidth / rect.height;
      mapped.movementY = (rotation === 90 ? -1 : 1) * (event.movementX || 0) * logicalHeight / rect.width;
    }
    for (const key of ['touches', 'changedTouches', 'targetTouches']) {
      if (!event[key]) continue;
      // Emscripten annotates touches; use mutable copies, not native Touch values.
      mapped[key] = Array.from(event[key], touch => ({
        identifier: touch.identifier, target: touch.target,
        screenX: touch.screenX, screenY: touch.screenY,
        radiusX: touch.radiusX, radiusY: touch.radiusY,
        rotationAngle: touch.rotationAngle, force: touch.force, ...point(touch)
      }));
    }
    return new Proxy(event, {
      get(target, key) {
        if (Object.prototype.hasOwnProperty.call(mapped, key)) return mapped[key];
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  window.PokerMobile = {
    nextArtwork() {
      let previous = 0;
      try { previous = Number(localStorage.getItem('poker-loading-art') || 0); } catch (_) {}
      const next = previous >= 1 && previous <= 5 ? ((previous - 1 + 1 + Math.floor(Math.random()*4)) % 5) + 1 : 1 + Math.floor(Math.random()*5);
      try { localStorage.setItem('poker-loading-art',String(next)); } catch (_) {}
      return next;
    },
    keyboardFraction: 0,
    setOrientation(landscape) {
      desired = landscape ? 'landscape' : 'portrait';
      refresh(); tryLock();
    },
    finishBoot() { bootVisible = false; refresh(); tryLock(); },
    mapInputEvent,
    refresh
  };
  function resume() { lockedOrientation = null; refresh(); tryLock(); }
  ['resize', 'orientationchange'].forEach(name => window.addEventListener(name, () => { refresh(); settleViewport(); tryLock(); }));
  ['pageshow', 'focus'].forEach(name => window.addEventListener(name, resume));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  document.addEventListener('pointerup', tryLock);
  document.addEventListener('touchend', tryLock, { passive: true });
  document.addEventListener('focusin', refresh);
  document.addEventListener('focusout', () => requestAnimationFrame(() => { refresh(); tryLock(); }));
  window.visualViewport?.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('scroll', refresh);
  screen.orientation?.addEventListener('change', () => { refresh(); settleViewport(); });
  refresh(); tryLock();
  // Initial HTML loading keeps its portrait image. Random artwork is used only
  // by Unity's multiplayer loading screen after START.
})();
