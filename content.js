/* AURAL GPT Script — manhwa recap runner
 * Queues "go N" prompts on chatgpt.com, auto-sends the next the instant the
 * previous response finishes, harvests the [Panel ...] script from every
 * chapter into one ordered book file, and can split a book across multiple
 * tabs to generate chapters in parallel.
 */
(() => {
  'use strict';

  if (window.__cgqrLoaded) return;
  window.__cgqrLoaded = true;

  // captured before ChatGPT's router can touch the URL
  const INITIAL_HASH = location.hash || '';

  // ---------------------------------------------------------------- helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const SELECTORS = {
    editor: '#prompt-textarea, div[contenteditable="true"].ProseMirror, div[role="textbox"]',
    sendBtn: 'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"]',
    stopBtn: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]',
    assistantMsg: 'div[data-message-author-role="assistant"]',
    assistantMsgFallback: 'div[data-message-id] div.markdown',
    userMsg: 'div[data-message-author-role="user"]',
    fileInput: 'input[type="file"]',
  };

  const getEditor = () => $(SELECTORS.editor);
  const getSendBtn = () => $(SELECTORS.sendBtn);
  const isGenerating = () => !!$(SELECTORS.stopBtn);
  const assistantNodes = () => {
    const primary = $$(SELECTORS.assistantMsg);
    return primary.length ? primary : $$(SELECTORS.assistantMsgFallback);
  };
  const assistantCount = () => assistantNodes().length;
  const userCount = () => $$(SELECTORS.userMsg).length;
  const lastAssistantText = () => {
    const nodes = assistantNodes();
    return nodes.length ? (nodes[nodes.length - 1].innerText || '') : '';
  };

  const now = () => Date.now();
  const fmtDur = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    mode: 'template',          // 'template' | 'list'
    template: 'go {n}',
    rangeStart: 1,
    rangeEnd: 20,
    list: '',
    delaySec: 3,               // pause after a response completes, before next send
    stableSec: 6,              // generation must stay stopped this long to count as done
    timeoutMin: 25,            // max time for one prompt before pausing the queue
    harvest: true,             // extract [Panel ...] script from each chapter
    beepWhenDone: true,
    sendSetupFirst: false,     // send master prompt + link + sample as message #1
    tabCount: 3,
    masterPrompt: '',
    bookLink: '',
    styleSample: '',
  };

  let settings = { ...DEFAULTS };

  function loadSettings(cb) {
    try {
      chrome.storage.local.get({ cgqrSettings: DEFAULTS }, (res) => {
        settings = { ...DEFAULTS, ...res.cgqrSettings };
        cb();
      });
    } catch {
      cb();
    }
  }

  function saveSettings() {
    try { chrome.storage.local.set({ cgqrSettings: settings }); } catch {}
  }

  // ---------------------------------------------------------------- state

  const PHASE = {
    IDLE: 'idle',
    DELAY: 'delay',
    INSERTING: 'inserting',
    SENDING: 'sending',
    GENERATING: 'generating',
    STABILIZING: 'stabilizing',
    FINISHED: 'finished',
    ERROR: 'error',
  };

  let state = {
    queue: [],        // [{ text, n, isSetup, status, startedAt, elapsedMs }]
    idx: 0,
    phase: PHASE.IDLE,
    paused: true,
    phaseSince: 0,
    sendRetries: 0,
    enterTried: false,
    lastClickAt: 0,
    baselineAssistantCount: 0,
    baselineUserCount: 0,
    promptStartedAt: 0,
    assignment: null, // { s, e } chapter range assigned to this tab
  };

  const STATE_KEY = 'cgqrState';
  const ASSIGN_KEY = 'cgqrAssign';

  function persistState() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        queue: state.queue,
        idx: state.idx,
        phase: state.phase,
      }));
    } catch {}
  }

  function restoreState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!saved.queue || !saved.queue.length) return false;
      state.queue = saved.queue;
      state.idx = saved.idx;
      state.phase = saved.phase === PHASE.FINISHED ? PHASE.FINISHED : PHASE.IDLE;
      state.paused = true;
      if (state.queue[state.idx] && state.queue[state.idx].status === 'running') {
        state.queue[state.idx].status = 'pending';
      }
      return true;
    } catch { return false; }
  }

  function loadAssignment() {
    const m = INITIAL_HASH.match(/#cgqr=(\d+)-(\d+)/);
    if (m) {
      state.assignment = { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
      try { sessionStorage.setItem(ASSIGN_KEY, JSON.stringify(state.assignment)); } catch {}
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
      return;
    }
    try {
      const raw = sessionStorage.getItem(ASSIGN_KEY);
      if (raw) state.assignment = JSON.parse(raw);
    } catch {}
  }

  function adoptAssignment() {
    if (!state.assignment) return;
    // in-memory only: each tab keeps its own range without clobbering the
    // shared settings other tabs read
    settings.rangeStart = state.assignment.s;
    settings.rangeEnd = state.assignment.e;
  }

  // ---------------------------------------------------------------- queue building

  function chapterNumberFromText(text, fallback) {
    const m = text.match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : fallback;
  }

  function buildQueue() {
    const items = [];
    if (settings.mode === 'template') {
      const start = Math.min(settings.rangeStart, settings.rangeEnd);
      const end = Math.max(settings.rangeStart, settings.rangeEnd);
      for (let n = start; n <= end; n++) {
        items.push({ text: settings.template.replaceAll('{n}', String(n)), n, status: 'pending', elapsedMs: 0 });
      }
    } else {
      settings.list.split('\n').map(s => s.trim()).filter(Boolean)
        .forEach((t, i) => items.push({ text: t, n: chapterNumberFromText(t, i + 1), status: 'pending', elapsedMs: 0 }));
    }
    if (settings.sendSetupFirst) {
      const setup = composeSetup();
      if (setup) items.unshift({ text: setup, isSetup: true, status: 'pending', elapsedMs: 0 });
      else log('Setup-first is on but the Book setup fields are empty — skipping setup message.');
    }
    return items;
  }

  function composeSetup() {
    const parts = [];
    if (settings.masterPrompt.trim()) parts.push(settings.masterPrompt.trim());
    if (settings.bookLink.trim()) parts.push('Book link for story context: ' + settings.bookLink.trim());
    if (settings.styleSample.trim()) parts.push('STYLE SAMPLE:\n' + settings.styleSample.trim());
    return parts.join('\n\n');
  }

  // ---------------------------------------------------------------- composer I/O

  // Select only inside the editor. NEVER use document.execCommand('selectAll'):
  // if the editor isn't the active element it selects the whole conversation,
  // and replacing that selection re-lays-out thousands of nodes — that is what
  // froze the page ("Page Unresponsive") on long chats.
  function selectAllInEditor(editor) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch { return false; }
  }

  function insertPrompt(text) {
    const editor = getEditor();
    if (!editor) return false;
    editor.focus();
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const landed = () => norm(editor.innerText).includes(norm(text.slice(0, 60)));
    // synthetic paste keeps line breaks in ProseMirror and is cheap even for
    // very large master prompts
    try {
      selectAllInEditor(editor);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (landed()) return true;
    } catch {}
    try {
      // insertText only when the editor really owns focus + selection
      if (document.activeElement === editor || editor.contains(document.activeElement)) {
        selectAllInEditor(editor);
        document.execCommand('insertText', false, text);
        if (landed()) return true;
      }
    } catch {}
    try {
      editor.innerHTML = '';
      text.split('\n').forEach(line => {
        const p = document.createElement('p');
        p.textContent = line;
        editor.appendChild(p);
      });
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    } catch { return false; }
  }

  // A 70–150KB setup message (master prompt + style sample) inserted in one
  // synchronous shot blocks the main thread long enough for the browser to
  // show "Page Unresponsive" — so big text goes in as small chunks, yielding
  // to the page between chunks.
  const INSERT_CHUNK = 8000;

  function caretToEnd(editor) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch { return false; }
  }

  function insertPromptAsync(text, done) {
    if (text.length <= INSERT_CHUNK) { done(insertPrompt(text)); return; }
    const editor = getEditor();
    if (!editor) { done(false); return; }
    editor.focus();
    selectAllInEditor(editor);
    try { document.execCommand('delete', false, null); } catch {}
    const chunks = [];
    for (let i = 0; i < text.length; i += INSERT_CHUNK) chunks.push(text.slice(i, i + INSERT_CHUNK));
    let i = 0;
    let usePaste = true;
    const step = () => {
      const ed = getEditor();
      if (!ed) { done(false); return; }
      ed.focus();
      caretToEnd(ed);
      const before = (ed.textContent || '').length;
      if (usePaste) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', chunks[i]);
          ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch {}
      }
      if ((ed.textContent || '').length <= before) {
        // paste was ignored — try insertText for this chunk instead
        usePaste = false;
        caretToEnd(ed);
        try { document.execCommand('insertText', false, chunks[i]); } catch {}
        if ((ed.textContent || '').length <= before) { done(false); return; }
      }
      i++;
      if (i < chunks.length) setTimeout(step, 40);
      else done(true);
    };
    setTimeout(step, 0);
  }

  function clickSend() {
    const btn = getSendBtn();
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    btn.click();
    return true;
  }

  // last-resort send if the send button selector ever breaks: ProseMirror
  // submits on a plain Enter keydown
  function pressEnterToSend() {
    const editor = getEditor();
    if (!editor || !(editor.innerText || '').trim()) return false;
    editor.focus();
    for (const type of ['keydown', 'keyup']) {
      editor.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    }
    return true;
  }

  function attachFiles(files) {
    // never target our own panel's file picker — injecting into it re-fires
    // its change listener and recurses until the tab hangs
    const inputs = $$(SELECTORS.fileInput).filter(i => !i.closest('#cgqr-panel'));
    if (!inputs.length) return false;
    const input = inputs.find(i => (i.accept || '').includes('pdf')) || inputs[0];
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    try {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- harvest / book

  const CHAP_PREFIX = 'cgqrChap_';

  function extractPanels(fullText) {
    const m = fullText.match(/\[Panel\s*\d+\]/i);
    if (!m) return null;
    return fullText.slice(m.index).trim();
  }

  function validateChapter(item, fullText, panels) {
    if (!panels) return 'response has no [Panel ...] lines';
    const hm = fullText.match(/Chapter:\s*(\d+)/i);
    if (item.n != null && hm && parseInt(hm[1], 10) !== item.n) {
      return `response says Chapter ${hm[1]} but this prompt asked for chapter ${item.n}`;
    }
    const nums = [...panels.matchAll(/\[Panel\s*(\d+)\]/gi)].map(x => parseInt(x[1], 10));
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) { log(`Note: panel numbering jumps at [Panel ${nums[i]}] (kept anyway).`); break; }
    }
    return null;
  }

  function saveChapter(n, text, cb) {
    try {
      chrome.storage.local.set({ [CHAP_PREFIX + n]: { n, text, at: now() } }, () => {
        const count = (text.match(/\[Panel\s*\d+\]/gi) || []).length;
        log(`Saved chapter ${n} to the book (${count} panels).`);
        updateBookUI();
        if (cb) cb();
      });
    } catch {}
  }

  function getBook(cb) {
    try {
      chrome.storage.local.get(null, (all) => {
        const chaps = Object.keys(all)
          .filter(k => k.startsWith(CHAP_PREFIX))
          .map(k => all[k])
          .filter(c => c && typeof c.n === 'number' && c.text)
          .sort((a, b) => a.n - b.n);
        cb(chaps);
      });
    } catch { cb([]); }
  }

  function buildBookText(chaps) {
    return chaps.map(c => c.text.trim()).join('\n\n') + '\n';
  }

  function copyBook() {
    getBook((chaps) => {
      if (!chaps.length) { log('No chapters saved yet.'); return; }
      const text = buildBookText(chaps);
      const done = () => {
        log(`Copied full script: ${chaps.length} chapters (${chaps[0].n}–${chaps[chaps.length - 1].n}).`);
        if (ui.copyBtn) {
          ui.copyBtn.textContent = '✓ Copied';
          setTimeout(() => { if (ui.copyBtn) ui.copyBtn.textContent = 'Copy full script'; }, 1800);
        }
      };
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { log('Copy failed — use Download instead.'); }
        ta.remove();
      };
      try {
        navigator.clipboard.writeText(text).then(done, fallback);
      } catch { fallback(); }
    });
  }

  function downloadBook() {
    getBook((chaps) => {
      if (!chaps.length) { log('No chapters saved yet.'); return; }
      const blob = new Blob([buildBookText(chaps)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'book-script.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      log(`Downloaded book-script.txt (${chaps.length} chapters).`);
    });
  }

  function clearBook() {
    if (!window.confirm('Delete all saved chapters from the book? This cannot be undone.')) return;
    try {
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all).filter(k => k.startsWith(CHAP_PREFIX));
        chrome.storage.local.remove(keys, () => {
          log(`Cleared ${keys.length} saved chapters.`);
          updateBookUI();
        });
      });
    } catch {}
  }

  function updateBookUI() {
    if (!ui.bookStatus) return;
    getBook((chaps) => {
      if (!ui.bookStatus) return;
      if (!chaps.length) { ui.bookStatus.textContent = 'No chapters saved yet.'; return; }
      const ns = chaps.map(c => c.n);
      const lo = ns[0], hi = ns[ns.length - 1];
      const missing = [];
      const have = new Set(ns);
      for (let i = lo; i <= hi; i++) if (!have.has(i)) missing.push(i);
      ui.bookStatus.textContent =
        `Saved: ${chaps.length} chapters (${lo}–${hi})` +
        (missing.length ? ` · missing: ${missing.join(', ')}` : '');
    });
  }

  // ---------------------------------------------------------------- multi-tab

  function splitRange(s, e, k) {
    const total = e - s + 1;
    const k2 = Math.max(1, Math.min(k, total));
    const base = Math.floor(total / k2);
    let extra = total % k2;
    const ranges = [];
    let cur = s;
    for (let i = 0; i < k2; i++) {
      const len = base + (extra-- > 0 ? 1 : 0);
      ranges.push([cur, cur + len - 1]);
      cur += len;
    }
    return ranges;
  }

  function openBatchTabs() {
    const s = Math.min(settings.rangeStart, settings.rangeEnd);
    const e = Math.max(settings.rangeStart, settings.rangeEnd);
    const ranges = splitRange(s, e, settings.tabCount);
    if (ranges.length < 2) { log('Range too small to split — just press Start here.'); return; }

    // this tab takes the first slice
    state.assignment = { s: ranges[0][0], e: ranges[0][1] };
    try { sessionStorage.setItem(ASSIGN_KEY, JSON.stringify(state.assignment)); } catch {}
    adoptAssignment();
    refreshRangeInputs();
    showAssignmentBanner();

    const urls = ranges.slice(1).map(r => `https://chatgpt.com/#cgqr=${r[0]}-${r[1]}`);
    let sent = false;
    try {
      chrome.runtime.sendMessage({ type: 'openTabs', urls }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) urls.forEach(u => window.open(u, '_blank'));
      });
      sent = true;
    } catch {}
    if (!sent) urls.forEach(u => window.open(u, '_blank'));

    log(`Split ${s}–${e} across ${ranges.length} tabs: ` +
      ranges.map((r, i) => `tab ${i + 1} → ${r[0]}–${r[1]}`).join(', '));
    log('This tab does the first slice. In each new tab: attach that tab\'s PDFs and press its Begin button.');
  }

  function beginAssignedRun(files) {
    const a = state.assignment || {
      s: Math.min(settings.rangeStart, settings.rangeEnd),
      e: Math.max(settings.rangeStart, settings.rangeEnd),
    };
    adoptAssignment();
    refreshRangeInputs();

    if (files && files.length) {
      const sorted = files.slice().sort((x, y) =>
        x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
      const rangeLen = a.e - a.s + 1;
      let picked;
      if (sorted.length === rangeLen) {
        picked = sorted;
        log(`Attaching ${picked.length} PDFs (you selected exactly this tab's chapters).`);
      } else if (sorted.length >= a.e) {
        picked = sorted.slice(a.s - 1, a.e);
        log(`You selected ${sorted.length} PDFs — using files ${a.s}–${a.e} by filename order for chapters ${a.s}–${a.e}.`);
      } else {
        log(`⚠️ You selected ${sorted.length} PDFs but this tab needs chapters ${a.s}–${a.e}. Select either exactly ${rangeLen} files or the whole book.`);
        return;
      }
      if (!attachFiles(picked)) {
        log('⚠️ Could not find ChatGPT\'s file upload input. Drag the PDFs into the chat manually, then press Start.');
        return;
      }
      log('PDFs handed to ChatGPT — uploads run while the setup message waits to send.');
    }

    settings.sendSetupFirst = true;
    state.queue = buildQueue();
    state.idx = 0;
    if (!state.queue.length) { log('Nothing to queue.'); return; }
    state.paused = false;
    state.sendRetries = 0;
    setPhase(PHASE.DELAY);
    state.phaseSince = now() - settings.delaySec * 1000;
    persistState();
    log(`Begun: setup message + chapters ${a.s}–${a.e}.`);
    updateUI();
  }

  // ---------------------------------------------------------------- notifications

  function beep() {
    if (!settings.beepWhenDone) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const play = (freq, t0, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.15, ctx.currentTime + t0);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
        osc.start(ctx.currentTime + t0);
        osc.stop(ctx.currentTime + t0 + dur);
      };
      play(880, 0, 0.25); play(1175, 0.3, 0.35);
    } catch {}
  }

  function flashTitle(prefix) {
    const orig = document.title.replace(/^(✅|⚠️) [^|]*\| /, '');
    document.title = `${prefix} | ${orig}`;
  }

  // ---------------------------------------------------------------- engine

  const TICK_MS = 500;
  const START_TIMEOUT_MS = 25000;      // normal prompt: generation must start within this
  const SETUP_START_TIMEOUT_MS = 600000; // setup message waits for big PDF uploads
  const MAX_SEND_RETRIES = 3;

  function setPhase(p) {
    state.phase = p;
    state.phaseSince = now();
    if (p === PHASE.SENDING) state.enterTried = false;
  }

  function currentItem() { return state.queue[state.idx]; }

  function startRun(fresh) {
    if (fresh) {
      state.queue = buildQueue();
      state.idx = 0;
      if (!state.queue.length) { log('Nothing to queue — check your template/list.'); return; }
    }
    if (state.idx >= state.queue.length) { log('Queue already finished. Reset to run again.'); return; }
    const item = currentItem();
    if (item && item.status === 'error') item.status = 'pending'; // retry after a validation failure
    state.paused = false;
    state.sendRetries = 0;
    setPhase(PHASE.DELAY);
    state.phaseSince = now() - settings.delaySec * 1000;
    log(fresh ? `Started queue: ${state.queue.length} prompts.` : 'Resumed.');
    persistState();
    updateUI();
  }

  function pauseRun(msg) {
    state.paused = true;
    if (msg) log(msg);
    persistState();
    updateUI();
  }

  function resetRun() {
    state.queue = [];
    state.idx = 0;
    state.paused = true;
    setPhase(PHASE.IDLE);
    try { sessionStorage.removeItem(STATE_KEY); } catch {}
    log('Queue reset (saved book chapters are kept).');
    updateUI();
  }

  function finishRun() {
    setPhase(PHASE.FINISHED);
    state.paused = true;
    persistState();
    log(`All ${state.queue.length} prompts completed. 🎉 Use "Copy full script" when every tab is done.`);
    flashTitle('✅ Queue done');
    beep();
    updateUI();
  }

  function failRun(reason) {
    const item = currentItem();
    if (item) item.status = 'error';
    setPhase(PHASE.ERROR);
    state.paused = true;
    persistState();
    log(`⚠️ ${reason} — queue paused. Press Resume to retry this prompt, or Skip to move on.`);
    flashTitle('⚠️ Queue paused');
    beep();
    updateUI();
  }

  function completeCurrentItem() {
    const item = currentItem();
    item.status = 'done';
    item.elapsedMs = now() - (item.startedAt || now());
    log(`Done ${state.idx + 1}/${state.queue.length} in ${fmtDur(item.elapsedMs)}.`);
    state.idx++;
    persistState();
    if (state.idx >= state.queue.length) finishRun();
    else { state.sendRetries = 0; setPhase(PHASE.DELAY); }
  }

  function tick() {
    try {
      runEngine();
    } catch (e) {
      // never let one bad tick take the page down
      log(`Engine error: ${e && e.message ? e.message : e}`);
      pauseRun('Unexpected error — queue paused.');
    }
    updateUI();
  }

  function runEngine() {
    if (state.paused) return;

    const item = currentItem();
    if (!item) return;
    const inPhase = now() - state.phaseSince;

    switch (state.phase) {
      case PHASE.DELAY: {
        if (inPhase >= settings.delaySec * 1000) {
          if (isGenerating()) {
            log('Page is still generating; waiting…');
            setPhase(PHASE.GENERATING);
            break;
          }
          // resumed after a pause during which the response already finished:
          // don't re-send, just wrap up the current item
          if (item.status === 'running' && assistantCount() > state.baselineAssistantCount) {
            setPhase(PHASE.STABILIZING);
            break;
          }
          state.baselineAssistantCount = assistantCount();
          state.baselineUserCount = userCount();
          item.status = 'running';
          item.startedAt = now();
          state.promptStartedAt = now();
          setPhase(PHASE.INSERTING);
          insertPromptAsync(item.text, (ok) => {
            if (state.phase !== PHASE.INSERTING) return; // reset/skip happened meanwhile
            if (!ok) { failRun('Could not find the ChatGPT input box'); return; }
            setPhase(PHASE.SENDING);
            log(`Sending ${state.idx + 1}/${state.queue.length}: "${item.isSetup ? 'setup message' : item.text}"`);
          });
        }
        break;
      }

      case PHASE.INSERTING: {
        // insertPromptAsync moves us on; this is just a watchdog
        if (inPhase > 120000) failRun('Inserting the prompt took too long');
        break;
      }

      case PHASE.SENDING: {
        if (isGenerating() || assistantCount() > state.baselineAssistantCount) {
          state.sendRetries = 0;
          setPhase(PHASE.GENERATING);
          break;
        }
        // the prompt already left the composer (a new user message exists in
        // the chat) — NEVER click or re-send after this point. A slow model
        // start (big PDFs, long thinking) used to trip the 25s retry below
        // and send the same "go N" twice, derailing the whole queue.
        if (userCount() > state.baselineUserCount) {
          if (now() - state.promptStartedAt > settings.timeoutMin * 60000) {
            failRun(`Prompt exceeded the ${settings.timeoutMin} min timeout`);
          }
          break;
        }
        // keep trying to click send (button enables after text insert /
        // uploads finish) — but at most one successful click per 1.5s so a
        // briefly-still-enabled button can't be double-clicked
        const clicked = (now() - state.lastClickAt > 1500) && clickSend();
        if (clicked) state.lastClickAt = now();
        if (!clicked && inPhase > 5000 && !state.enterTried && !item.isSetup) {
          state.enterTried = true;
          if (pressEnterToSend()) log('Send button not found — trying Enter key fallback.');
        }
        const startTimeout = item.isSetup ? SETUP_START_TIMEOUT_MS : START_TIMEOUT_MS;
        if (inPhase > startTimeout) {
          if (state.sendRetries < MAX_SEND_RETRIES) {
            state.sendRetries++;
            log(`Message never left the composer — retry ${state.sendRetries}/${MAX_SEND_RETRIES}…`);
            setPhase(PHASE.INSERTING);
            insertPromptAsync(item.text, (ok) => {
              if (state.phase !== PHASE.INSERTING) return;
              if (!ok) { failRun('Could not find the ChatGPT input box'); return; }
              setPhase(PHASE.SENDING);
            });
          } else {
            failRun('The prompt could not be sent');
          }
        }
        break;
      }

      case PHASE.GENERATING: {
        if (now() - state.promptStartedAt > settings.timeoutMin * 60000) {
          failRun(`Prompt exceeded the ${settings.timeoutMin} min timeout`);
          break;
        }
        if (!isGenerating()) setPhase(PHASE.STABILIZING);
        break;
      }

      case PHASE.STABILIZING: {
        if (isGenerating()) { setPhase(PHASE.GENERATING); break; } // it resumed (tool use, multi-step)
        if (inPhase >= settings.stableSec * 1000) {
          // no response node yet — the model hasn't actually answered (it may
          // still be thinking without visible streaming). Don't complete on a
          // stale previous response; keep waiting up to the Max min timeout.
          if (assistantCount() <= state.baselineAssistantCount) {
            if (now() - state.promptStartedAt > settings.timeoutMin * 60000) {
              failRun(`Prompt exceeded the ${settings.timeoutMin} min timeout`);
            }
            break;
          }
          if (!item.isSetup && settings.harvest) {
            const full = lastAssistantText();
            const panels = extractPanels(full);
            const err = validateChapter(item, full, panels);
            if (err) { failRun(`Chapter ${item.n}: ${err}`); break; }
            saveChapter(item.n, panels);
          }
          completeCurrentItem();
        }
        break;
      }

      default:
        break;
    }
  }

  setInterval(tick, TICK_MS);

  // ---------------------------------------------------------------- UI

  let ui = {};
  const logLines = [];
  const UI_PREFS_KEY = 'cgqrUiPrefs';

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    logLines.push(`[${t}] ${msg}`);
    if (logLines.length > 300) logLines.shift();
    if (ui.log) {
      ui.log.textContent = logLines.join('\n');
      ui.log.scrollTop = ui.log.scrollHeight;
    }
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  function makeSwitch(checked, labelText, title) {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    const row = el('label', { class: 'cgqr-switch-row', title: title || '' },
      el('span', { class: 'cgqr-switch-label', text: labelText }),
      el('span', { class: 'cgqr-switch' }, input, el('span', { class: 'cgqr-switch-track' })));
    return { row, input };
  }

  function loadUiPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_PREFS_KEY)) || {}; } catch { return {}; }
  }
  function saveUiPrefs(prefs) {
    try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs)); } catch {}
  }

  function refreshRangeInputs() {
    if (ui.fromInput) ui.fromInput.value = settings.rangeStart;
    if (ui.toInput) ui.toInput.value = settings.rangeEnd;
  }

  function showAssignmentBanner() {
    if (!ui.banner || !state.assignment) return;
    ui.banner.classList.remove('cgqr-hidden');
    ui.bannerText.textContent = `This tab: chapters ${state.assignment.s}–${state.assignment.e}`;
  }

  function makeDraggable(panel, handle) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - 80, startLeft + e.clientX - startX));
      const top = Math.max(0, Math.min(window.innerHeight - 40, startTop + e.clientY - startY));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const prefs = loadUiPrefs();
      prefs.left = panel.style.left;
      prefs.top = panel.style.top;
      saveUiPrefs(prefs);
    });
  }

  function buildPanel() {
    const prefs = loadUiPrefs();
    const panel = el('div', { id: 'cgqr-panel' });
    if (prefs.left && prefs.top) {
      panel.style.left = prefs.left;
      panel.style.top = prefs.top;
      panel.style.right = 'auto';
    }

    // ---- header / brand
    ui.statusDot = el('span', { class: 'cgqr-dot cgqr-dot-idle' });
    const collapseBtn = el('button', { class: 'cgqr-icon-btn', title: 'Collapse' },
      el('span', { class: 'cgqr-chevron' }));
    const header = el('div', { class: 'cgqr-header' },
      el('div', { class: 'cgqr-brand' },
        el('div', { class: 'cgqr-logo', text: 'A' }),
        el('div', { class: 'cgqr-brand-text' },
          el('div', { class: 'cgqr-brand-name', text: 'AURAL' }),
          el('div', { class: 'cgqr-brand-sub', text: 'GPT Script Runner' }))),
      el('div', { class: 'cgqr-header-actions' }, ui.statusDot, collapseBtn));
    panel.appendChild(header);

    const body = el('div', { class: 'cgqr-body' });
    panel.appendChild(body);

    const setCollapsed = (collapsed) => {
      body.classList.toggle('cgqr-hidden', collapsed);
      panel.classList.toggle('cgqr-collapsed', collapsed);
      const p = loadUiPrefs(); p.collapsed = collapsed; saveUiPrefs(p);
    };
    collapseBtn.addEventListener('click', () => setCollapsed(!body.classList.contains('cgqr-hidden')));
    if (prefs.collapsed) setCollapsed(true);

    makeDraggable(panel, header);

    // ---- assignment banner (batch tabs)
    ui.bannerText = el('span', { class: 'cgqr-banner-text', text: '' });
    const attachInput = el('input', { type: 'file', accept: '.pdf,application/pdf', multiple: 'multiple', class: 'cgqr-hidden' });
    const beginBtn = el('button', { class: 'cgqr-btn cgqr-btn-primary', text: 'Attach PDFs + Begin' });
    beginBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      const files = Array.from(attachInput.files || []);
      if (files.length) beginAssignedRun(files);
      attachInput.value = '';
    });
    const beginNoPdfBtn = el('button', { class: 'cgqr-btn', text: 'Begin (PDFs uploaded)' });
    beginNoPdfBtn.addEventListener('click', () => beginAssignedRun(null));
    ui.banner = el('div', { class: 'cgqr-banner cgqr-hidden' },
      ui.bannerText,
      el('div', { class: 'cgqr-controls' }, beginBtn, beginNoPdfBtn),
      attachInput);
    body.appendChild(ui.banner);

    // ---- book setup (collapsible card)
    const masterArea = el('textarea', { class: 'cgqr-textarea', rows: '4', placeholder: 'Your big master prompt…' });
    masterArea.value = settings.masterPrompt;
    const linkInput = el('input', { class: 'cgqr-input', placeholder: 'https://mangafire.to/… (book link)' });
    linkInput.value = settings.bookLink;
    const sampleArea = el('textarea', { class: 'cgqr-textarea', rows: '3', placeholder: 'STYLE SAMPLE — paste example script lines…' });
    sampleArea.value = settings.styleSample;
    const sendSetupBtn = el('button', { class: 'cgqr-btn', text: 'Send setup now' });
    sendSetupBtn.addEventListener('click', () => {
      const setup = composeSetup();
      if (!setup) { log('Book setup fields are empty.'); return; }
      log('Inserting setup message…');
      insertPromptAsync(setup, (ok) => {
        if (!ok) { log('Could not find the ChatGPT input box.'); return; }
        setTimeout(() => { if (!clickSend()) log('Setup text inserted — press ChatGPT\'s send button when uploads finish.'); }, 600);
        log('Setup message sent (or waiting on uploads).');
      });
    });
    const setupDetails = el('details', { class: 'cgqr-details' },
      el('summary', { class: 'cgqr-summary', text: 'Book setup' }),
      el('div', { class: 'cgqr-card-body' },
        el('label', { class: 'cgqr-label', text: 'Master prompt' }), masterArea,
        el('label', { class: 'cgqr-label', text: 'Book link' }), linkInput,
        el('label', { class: 'cgqr-label', text: 'Style sample' }), sampleArea,
        sendSetupBtn));
    body.appendChild(el('div', { class: 'cgqr-card' }, setupDetails));

    // ---- queue card: mode toggle + range + timing
    const modeTemplate = el('button', { class: 'cgqr-tab', text: 'Template' });
    const modeList = el('button', { class: 'cgqr-tab', text: 'Custom list' });

    const tplInput = el('input', { class: 'cgqr-input', value: settings.template, title: '{n} is replaced with the number' });
    ui.fromInput = el('input', { class: 'cgqr-input cgqr-num', type: 'number', value: settings.rangeStart });
    ui.toInput = el('input', { class: 'cgqr-input cgqr-num', type: 'number', value: settings.rangeEnd });
    const tplSection = el('div', { class: 'cgqr-section' },
      el('label', { class: 'cgqr-label', text: 'Prompt template · {n} = chapter' }),
      tplInput,
      el('div', { class: 'cgqr-row' },
        el('label', { class: 'cgqr-label-inline', text: 'From' }), ui.fromInput,
        el('label', { class: 'cgqr-label-inline', text: 'to' }), ui.toInput));

    const listArea = el('textarea', { class: 'cgqr-textarea', rows: '5', placeholder: 'One prompt per line…' });
    listArea.value = settings.list;
    const listSection = el('div', { class: 'cgqr-section cgqr-hidden' },
      el('label', { class: 'cgqr-label', text: 'Prompts (one per line)' }), listArea);

    const delayInput = el('input', { class: 'cgqr-input cgqr-num', type: 'number', min: '0', value: settings.delaySec });
    const stableInput = el('input', { class: 'cgqr-input cgqr-num', type: 'number', min: '2', value: settings.stableSec });
    const timeoutInput = el('input', { class: 'cgqr-input cgqr-num', type: 'number', min: '1', value: settings.timeoutMin });
    const timingRow = el('div', { class: 'cgqr-row cgqr-row-3' },
      el('div', { class: 'cgqr-field' },
        el('label', { class: 'cgqr-label', text: 'Delay s', title: 'Wait after a response finishes before sending the next prompt' }), delayInput),
      el('div', { class: 'cgqr-field' },
        el('label', { class: 'cgqr-label', text: 'Settle s', title: 'How long generation must stay stopped to count as finished' }), stableInput),
      el('div', { class: 'cgqr-field' },
        el('label', { class: 'cgqr-label', text: 'Max min', title: 'Pause the queue if one prompt takes longer than this' }), timeoutInput));

    body.appendChild(el('div', { class: 'cgqr-card' },
      el('div', { class: 'cgqr-tabs' }, modeTemplate, modeList),
      tplSection, listSection, timingRow));

    function applyMode() {
      const isTpl = settings.mode === 'template';
      modeTemplate.classList.toggle('cgqr-tab-active', isTpl);
      modeList.classList.toggle('cgqr-tab-active', !isTpl);
      tplSection.classList.toggle('cgqr-hidden', !isTpl);
      listSection.classList.toggle('cgqr-hidden', isTpl);
    }
    modeTemplate.addEventListener('click', () => { settings.mode = 'template'; saveSettings(); applyMode(); });
    modeList.addEventListener('click', () => { settings.mode = 'list'; saveSettings(); applyMode(); });

    // ---- options card: switches + parallel tabs
    const harvestSw = makeSwitch(settings.harvest, 'Harvest [Panel] script into book');
    const setupSw = makeSwitch(settings.sendSetupFirst, 'Send Book setup first on Start');
    const beepSw = makeSwitch(settings.beepWhenDone, 'Beep on finish / error');

    const tabSelect = el('select', { class: 'cgqr-input cgqr-select' });
    [2, 3, 4].forEach(k => tabSelect.appendChild(el('option', { value: String(k), text: `${k} tabs` })));
    tabSelect.value = String(settings.tabCount);
    tabSelect.addEventListener('change', () => { settings.tabCount = parseInt(tabSelect.value, 10) || 3; saveSettings(); });
    const batchBtn = el('button', { class: 'cgqr-btn', text: 'Open batch tabs' });
    batchBtn.addEventListener('click', openBatchTabs);

    body.appendChild(el('div', { class: 'cgqr-card' },
      harvestSw.row, setupSw.row, beepSw.row,
      el('div', { class: 'cgqr-row cgqr-row-parallel' },
        el('label', { class: 'cgqr-label-inline', text: 'Parallel', title: 'Split the chapter range across this many tabs' }),
        tabSelect, batchBtn)));

    const bind = (input, key, parse) => input.addEventListener('change', () => {
      settings[key] = parse(input);
      saveSettings();
    });
    bind(tplInput, 'template', i => i.value);
    bind(ui.fromInput, 'rangeStart', i => parseInt(i.value, 10) || 1);
    bind(ui.toInput, 'rangeEnd', i => parseInt(i.value, 10) || 1);
    bind(listArea, 'list', i => i.value);
    bind(delayInput, 'delaySec', i => Math.max(0, parseFloat(i.value) || 0));
    bind(stableInput, 'stableSec', i => Math.max(2, parseFloat(i.value) || 6));
    bind(timeoutInput, 'timeoutMin', i => Math.max(1, parseFloat(i.value) || 25));
    bind(harvestSw.input, 'harvest', i => i.checked);
    bind(setupSw.input, 'sendSetupFirst', i => i.checked);
    bind(beepSw.input, 'beepWhenDone', i => i.checked);
    bind(masterArea, 'masterPrompt', i => i.value);
    bind(linkInput, 'bookLink', i => i.value);
    bind(sampleArea, 'styleSample', i => i.value);

    // ---- controls
    const startBtn = el('button', { class: 'cgqr-btn cgqr-btn-primary cgqr-btn-start', text: 'Start' });
    const pauseBtn = el('button', { class: 'cgqr-btn', text: 'Pause' });
    const skipBtn = el('button', { class: 'cgqr-btn', text: 'Skip', title: 'Mark current prompt done and move on' });
    const resetBtn = el('button', { class: 'cgqr-btn cgqr-btn-danger', text: 'Reset' });
    body.appendChild(el('div', { class: 'cgqr-controls cgqr-controls-main' }, startBtn, pauseBtn, skipBtn, resetBtn));

    startBtn.addEventListener('click', () => {
      if (state.queue.length && state.idx < state.queue.length &&
          state.phase !== PHASE.FINISHED) {
        startRun(false);
      } else {
        startRun(true);
      }
    });
    pauseBtn.addEventListener('click', () => pauseRun('Paused. Current response (if any) keeps generating; no new prompts will be sent.'));
    skipBtn.addEventListener('click', () => {
      const item = currentItem();
      if (!item) return;
      item.status = 'done';
      state.idx++;
      persistState();
      log(`Skipped "${item.isSetup ? 'setup message' : item.text}".`);
      if (state.idx >= state.queue.length && state.queue.length) finishRun();
      else setPhase(PHASE.DELAY);
    });
    resetBtn.addEventListener('click', resetRun);

    // ---- status + progress
    ui.status = el('div', { class: 'cgqr-status', text: 'Idle' });
    ui.progressBar = el('div', { class: 'cgqr-progress-fill' });
    body.appendChild(ui.status);
    body.appendChild(el('div', { class: 'cgqr-progress' }, ui.progressBar));

    // ---- book / script output
    ui.bookStatus = el('div', { class: 'cgqr-book-status', text: '…' });
    ui.copyBtn = el('button', { class: 'cgqr-btn cgqr-btn-primary', text: 'Copy full script' });
    ui.copyBtn.addEventListener('click', copyBook);
    const dlBtn = el('button', { class: 'cgqr-btn', text: 'Download' });
    dlBtn.addEventListener('click', downloadBook);
    const clearBtn = el('button', { class: 'cgqr-btn cgqr-btn-danger', text: 'Clear' });
    clearBtn.addEventListener('click', clearBook);
    body.appendChild(el('div', { class: 'cgqr-card cgqr-book' },
      el('label', { class: 'cgqr-label', text: 'Book script' }),
      ui.bookStatus,
      el('div', { class: 'cgqr-controls' }, ui.copyBtn, dlBtn, clearBtn)));

    // ---- log
    ui.log = el('pre', { class: 'cgqr-log' });
    body.appendChild(ui.log);

    ui.startBtn = startBtn;
    applyMode();
    document.documentElement.appendChild(panel);
  }

  let lastStatusText = '';
  function updateUI() {
    if (!ui.status) return;
    const total = state.queue.length;
    const done = state.queue.filter(q => q.status === 'done').length;
    let text;
    let dotClass = 'cgqr-dot-idle';
    if (!total) {
      text = 'Idle — configure and press Start';
      ui.startBtn.textContent = 'Start';
    } else if (state.phase === PHASE.FINISHED) {
      text = `✅ Finished ${done}/${total}`;
      ui.startBtn.textContent = 'Start';
      dotClass = 'cgqr-dot-done';
    } else if (state.paused) {
      text = `⏸ Paused at ${done}/${total}`;
      ui.startBtn.textContent = 'Resume';
      dotClass = state.phase === PHASE.ERROR ? 'cgqr-dot-error' : 'cgqr-dot-paused';
    } else {
      const item = currentItem();
      const phaseLabel = {
        [PHASE.DELAY]: 'waiting to send',
        [PHASE.INSERTING]: 'inserting prompt',
        [PHASE.SENDING]: 'sending',
        [PHASE.GENERATING]: 'generating',
        [PHASE.STABILIZING]: 'finishing up',
      }[state.phase] || state.phase;
      const label = item ? (item.isSetup ? 'setup message' : `"${item.text}"`) : '';
      const elapsed = item && item.startedAt ? ` · ${fmtDur(now() - item.startedAt)}` : '';
      text = `${done}/${total} done — ${phaseLabel}${label ? `: ${label}` : ''}${elapsed}`;
      ui.startBtn.textContent = 'Running…';
      dotClass = 'cgqr-dot-live';
    }
    if (text !== lastStatusText) {
      lastStatusText = text;
      ui.status.textContent = text;
    }
    if (ui.statusDot && !ui.statusDot.classList.contains(dotClass)) {
      ui.statusDot.className = `cgqr-dot ${dotClass}`;
    }
    ui.progressBar.style.width = total ? `${(done / total) * 100}%` : '0%';
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    loadSettings(() => {
      loadAssignment();
      adoptAssignment();
      buildPanel();
      refreshRangeInputs();
      if (state.assignment) showAssignmentBanner();
      const restored = restoreState();
      if (restored && state.queue.length && state.idx < state.queue.length) {
        log(`Restored previous queue (${state.idx}/${state.queue.length} done). Press Resume to continue.`);
      } else if (state.assignment) {
        log(`This tab is assigned chapters ${state.assignment.s}–${state.assignment.e}. Attach the PDFs and press Begin.`);
      } else {
        log('Ready. Fill Book setup once, set your range, press Start — or split across tabs with Open batch tabs.');
      }
      updateBookUI();
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && Object.keys(changes).some(k => k.startsWith(CHAP_PREFIX))) updateBookUI();
        });
      } catch {}
      updateUI();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
