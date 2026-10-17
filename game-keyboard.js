// A game-aligned keyboard only when iPhone refuses a native landscape lock.
// Keep this before Unity so readOnly is set before WebKit receives focus().
(() => {
  if (window.PokerGameKeyboard) return;
  let state = null, panel = null, height = 0, mode = 'letters', shifted = false;
  let lastReported = '', notificationQueued = false, suspended = false, pendingRelease = null;
  const nativeFocus = {};
  const isIPhone = /iPhone/.test(navigator.userAgent || '');
  const shouldUse = () => isIPhone && !suspended && !document.hidden && !!window.PokerMobile?.needsGameKeyboard?.();
  const acceptsText = field => field && !field.disabled && !field.readOnly &&
    (field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' &&
      /^(text|search|email|url|tel|password|number)$/.test(field.type || 'text')));
  const rows = {
    letters: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
    polish: ['ąćęłńóśźż', 'asdfghjkl', 'zxcvbnm'],
    symbols: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['!', '?', '.', ',', ':', ';', '+', '-', '=', '/'],
      ['@', '#', '(', ')', '"', "'", '_', '♥', '♠']]
  };

  function notify() {
    if (notificationQueued) return;
    notificationQueued = true;
    // A field switch restores the old field before preparing the new one.
    // Notify only once that complete transition is visible to mobile.refresh.
    Promise.resolve().then(() => {
      notificationQueued = false;
      const current = `${!!state?.open}:${height}`;
      if (current === lastReported) return;
      lastReported = current;
      window.dispatchEvent(new Event('pokerkeyboardchange'));
    });
  }

  function selection(field) {
    const end = field.value.length;
    return {
      start: typeof field.selectionStart === 'number' ? field.selectionStart : end,
      end: typeof field.selectionEnd === 'number' ? field.selectionEnd : end,
      direction: field.selectionDirection || 'none'
    };
  }

  function select(field, start, end = start, direction = 'none') {
    try { field.setSelectionRange(start, end, direction); } catch (_) { /* Numeric inputs do not expose a selection. */ }
  }

  function inputEvent(field, inputType, data = null) {
    const event = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType, data }) : new Event('input', { bubbles: true });
    field.dispatchEvent(event);
  }

  function restoreAttribute(field, name, value) {
    if (value === null) field.removeAttribute(name); else field.setAttribute(name, value);
  }

  function release() {
    if (!state) return;
    const previous = state;
    state = null;
    previous.field.readOnly = previous.readOnly;
    restoreAttribute(previous.field, 'readonly', previous.readonlyAttribute);
    previous.field.inputMode = previous.inputMode;
    restoreAttribute(previous.field, 'inputmode', previous.inputmodeAttribute);
    if (previous.nativeContainer) {
      previous.nativeContainer.style.opacity = previous.nativeOpacity;
      previous.nativeContainer.style.pointerEvents = previous.nativePointerEvents;
    }
    if (panel) panel.style.display = 'none';
    height = 0;
    notify();
  }

  function dismiss(cancel = false) {
    if (!state) return;
    if (cancel && state.field.value !== state.initialValue) {
      state.field.value = state.initialValue;
      select(state.field, state.initialSelection.start, state.initialSelection.end, state.initialSelection.direction);
      inputEvent(state.field, 'historyUndo');
    }
    state.open = false;
    panel.style.display = 'none';
    height = 0;
    // Do not blur or synthesize Enter: Unity treats both as finishing a mobile
    // keyboard and TMP can submit chat. Keep the draft until the game sends it.
    // Suppression is restored on a real field change, removal or native mode.
    notify();
  }

  function edit(text, erase = false) {
    if (!state?.open) return;
    const field = state.field, range = selection(field);
    let start = range.start, end = range.end;
    if (erase && start === end && start > 0) {
      const previous = Array.from(field.value.slice(0, start)).pop();
      start -= previous?.length || 1;
    }
    let insert = erase ? '' : text;
    if (typeof field.maxLength === 'number' && field.maxLength >= 0) {
      insert = insert.slice(0, Math.max(0, field.maxLength - (field.value.length - (end - start))));
    }
    const value = field.value.slice(0, start) + insert + field.value.slice(end);
    if (value === field.value) return;
    field.value = value;
    select(field, start + insert.length);
    inputEvent(field, erase ? 'deleteContentBackward' : 'insertText', insert || null);
    // Validators may normalize the value synchronously in their input handler.
    select(field, Math.min(start + insert.length, field.value.length));
    if (shifted && !erase && insert.trim()) { shifted = false; render(); }
  }

  function moveCaret(direction) {
    if (!state?.open) return;
    const field = state.field, range = selection(field);
    let next;
    if (range.start !== range.end) next = direction < 0 ? range.start : range.end;
    else if (direction < 0) next = range.start - (Array.from(field.value.slice(0, range.start)).pop()?.length || 0);
    else next = range.end + (Array.from(field.value.slice(range.end))[0]?.length || 0);
    select(field, Math.max(0, Math.min(field.value.length, next)));
  }

  function stop(event) { event.preventDefault(); event.stopPropagation(); }

  function afterRelease(event, action) {
    pendingRelease?.();
    const editingState = state;
    const endName = event.type === 'touchstart' ? 'touchend' : event.type === 'mousedown' ? 'mouseup' : 'pointerup';
    const cancelName = event.type === 'touchstart' ? 'touchcancel' : 'pointercancel';
    const cleanup = () => {
      window.removeEventListener(endName, finish, true);
      window.removeEventListener(cancelName, cancel, true);
      if (pendingRelease === cleanup) pendingRelease = null;
    };
    const samePointer = next => event.pointerId === undefined || next.pointerId === event.pointerId;
    const finish = next => {
      if (!samePointer(next)) return;
      stop(next); cleanup();
      if (state === editingState) action();
    };
    const cancel = next => { if (samePointer(next)) { stop(next); cleanup(); } };
    pendingRelease = cleanup;
    // Keep the keyboard in place until pointerup, then swallow that release
    // before removing it. Otherwise a finger can release over Unity's Send.
    window.addEventListener(endName, finish, true);
    window.addEventListener(cancelName, cancel, true);
  }

  function key(row, label, action, wide = false, caption = label) {
    const button = document.createElement('button');
    button.type = 'button'; button.tabIndex = -1; button.textContent = caption;
    button.setAttribute('aria-label', label);
    button.dataset.key = label;
    button.style.cssText = 'min-width:0;min-height:0;border:1px solid #77613a;border-radius:6px;' +
      'background:#193a2c;color:#fff4d3;font:600 clamp(14px,calc(var(--view-width,812px) * .025),20px) Arial,sans-serif;' +
      'padding:0 2px;touch-action:none;user-select:none;-webkit-user-select:none;' +
      (wide ? 'flex:4;' : 'flex:1;');
    const press = event => {
      stop(event);
      if (label === 'OK' || label === 'Anuluj') afterRelease(event, action);
      else action();
    };
    if (window.PointerEvent) button.addEventListener('pointerdown', press);
    else {
      button.addEventListener('touchstart', press, { passive: false });
      button.addEventListener('mousedown', press);
    }
    button.addEventListener('click', event => {
      stop(event);
      // VoiceOver activates a button with a click without a preceding pointer.
      if (event.detail === 0) action();
    });
    row.appendChild(button);
  }

  function ensurePanel() {
    const container = document.getElementById('unity-container');
    if (!container) return false;
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'poker-game-keyboard';
      panel.setAttribute('aria-label', 'Klawiatura gry');
      panel.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:20;display:none;' +
        'box-sizing:border-box;padding:6px max(6px,env(safe-area-inset-right)) 6px max(6px,env(safe-area-inset-left));' +
        'gap:4px;grid-template-rows:repeat(4,minmax(0,1fr));background:#071c14;' +
        'border-top:1px solid #c8a350;box-shadow:0 -4px 14px #0008;touch-action:none;';
      for (const name of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
        'touchstart', 'touchend', 'touchmove', 'click', 'dblclick', 'contextmenu']) {
        panel.addEventListener(name, stop, { passive: false });
      }
    }
    if (panel.parentNode !== container) container.appendChild(panel);
    return true;
  }

  function render() {
    if (!panel || !state?.open) return;
    panel.replaceChildren();
    const makeRow = () => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;min-height:0;';
      panel.appendChild(row); return row;
    };
    rows[mode].forEach((values, index) => {
      const row = makeRow();
      if (index === 2) key(row, 'Wielkie litery', () => { shifted = !shifted; render(); }, false, shifted ? '⇧●' : '⇧');
      for (const value of values) {
        const character = shifted ? value.toLocaleUpperCase('pl') : value;
        key(row, character, () => edit(character));
      }
      if (index === 2) key(row, 'Usuń', () => edit('', true), false, '⌫');
    });
    const bottom = makeRow();
    key(bottom, mode === 'symbols' ? 'ABC' : '123', () => { mode = mode === 'symbols' ? 'letters' : 'symbols'; shifted = false; render(); });
    key(bottom, mode === 'polish' ? 'ABC' : 'ĄĘ', () => { mode = mode === 'polish' ? 'letters' : 'polish'; shifted = false; render(); });
    key(bottom, 'Kursor w lewo', () => moveCaret(-1), false, '◀');
    key(bottom, 'Spacja', () => edit(' '), true);
    key(bottom, 'Kursor w prawo', () => moveCaret(1), false, '▶');
    key(bottom, 'Anuluj', () => dismiss(true), false, '✕');
    key(bottom, 'OK', () => dismiss(false));
  }

  function refresh() {
    if (!state) {
      if (shouldUse() && document.activeElement?.isConnected !== false && acceptsText(document.activeElement)) activate(document.activeElement);
      return;
    }
    if (!shouldUse()) {
      const field = state.field;
      const resumeNative = !suspended && !document.hidden && field.isConnected !== false && document.activeElement === field;
      release();
      // Refocus directly with the original method, never blur/Enter: those are
      // submit signals in Unity. Only the same still-focused field may resume.
      if (resumeNative) {
        try { nativeFocus[field.tagName]?.call(field, { preventScroll: true }); } catch (_) { /* Next native tap can retry. */ }
      }
      return;
    }
    if (state.field.isConnected === false || (state.focused && document.activeElement !== state.field)) { release(); return; }
    if (!state.open || !ensurePanel()) return;
    const container = panel.parentNode;
    const logicalHeight = container.clientHeight || parseFloat(container.style.height) || window.innerHeight;
    const pixels = Math.min(244, logicalHeight * .72, Math.max(204, logicalHeight * .56));
    panel.style.height = pixels + 'px'; panel.style.display = 'grid';
    height = logicalHeight > 0 ? Math.min(1, pixels / logicalHeight) : 0;
    notify();
  }

  function activate(field) {
    if (!shouldUse() || (!acceptsText(field) && state?.field !== field) || !ensurePanel()) return false;
    if (state?.field !== field) {
      release();
      const nativeContainer = field.parentNode?.input === field ? field.parentNode : null;
      state = {
        field, readOnly: field.readOnly, readonlyAttribute: field.getAttribute('readonly'),
        inputMode: field.inputMode, inputmodeAttribute: field.getAttribute('inputmode'),
        initialValue: field.value, initialSelection: selection(field),
        nativeContainer, nativeOpacity: nativeContainer?.style.opacity,
        nativePointerEvents: nativeContainer?.style.pointerEvents,
        focused: document.activeElement === field
      };
      mode = 'letters'; shifted = false;
    } else if (!state.open) {
      state.initialValue = field.value;
      state.initialSelection = selection(field);
    }
    // These assignments must precede the real focus/select call on iOS.
    field.readOnly = true; field.inputMode = 'none'; field.setAttribute('inputmode', 'none');
    if (state.nativeContainer) {
      state.nativeContainer.style.opacity = '0';
      state.nativeContainer.style.pointerEvents = 'none';
    }
    state.open = true;
    render(); refresh();
    return true;
  }

  for (const Constructor of [window.HTMLInputElement, window.HTMLTextAreaElement]) {
    if (!Constructor) continue;
    for (const name of ['focus', 'select']) {
      const original = Constructor.prototype[name];
      if (typeof original !== 'function') continue;
      if (name === 'focus') nativeFocus[Constructor === window.HTMLTextAreaElement ? 'TEXTAREA' : 'INPUT'] = original;
      Constructor.prototype[name] = function (...args) {
        const intercepted = activate(this);
        let result;
        try { result = original.apply(this, args); }
        catch (error) { if (intercepted) release(); throw error; }
        if (intercepted && state?.field === this) {
          state.focused = document.activeElement === this;
          refresh();
        }
        return result;
      };
    }
  }

  document.addEventListener('focusin', event => {
    if (state?.field !== event.target) activate(event.target);
    if (state?.field === event.target) { state.focused = true; refresh(); }
  }, true);
  document.addEventListener('focusout', () => Promise.resolve().then(refresh), true);
  document.addEventListener('visibilitychange', () => {
    suspended = document.hidden;
    if (suspended) { pendingRelease?.(); release(); } else refresh();
  });
  window.addEventListener('resize', refresh);
  window.addEventListener('pagehide', () => { suspended = true; pendingRelease?.(); release(); });
  window.addEventListener('pageshow', () => { suspended = false; refresh(); });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (state?.field.isConnected === false) release(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
  window.PokerGameKeyboard = {
    shouldUse, refresh, dismiss, release,
    get isActive() { return !!state?.open; },
    get heightFraction() { return height; }
  };
})();
