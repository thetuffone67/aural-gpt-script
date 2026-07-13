/* Aural Chapter Desk — deliberately simple, send-once ChatGPT runner. */
(() => {
  'use strict';
  if (window.__auralChapterDesk) return;
  window.__auralChapterDesk = true;

  const INITIAL_HASH = location.hash || '';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const now = () => Date.now();
  const SETTINGS_KEY = 'auralDeskSettings';
  const RUN_KEY = 'auralDeskRun';
  const ASSIGNMENT_KEY = 'auralDeskAssignment';
  const CHAPTER_KEY = 'auralDeskChapter_';
  const LEGACY_CHAPTER_KEY = 'cgqrChap_';
  const FOLDER_DB = 'auralChapterDeskFiles';
  const FOLDER_STORE = 'handles';
  const FOLDER_RECORD = 'selected-pdf-folder';

  const DEFAULTS = {
    template: 'go {n}', start: 1, end: 20, harvest: true, sendSetup: false, masterPrompt: '', bookLinks: ['', '', '', '', ''],
    styleSample: '', tabCount: 3, folderAutomation: false, folderName: '',
  };
  let settings = { ...DEFAULTS };
  let assignment = null;
  let ui = {};
  let lastStatus = '';

  const PHASE = {
    IDLE: 'idle', COOLDOWN: 'cooldown', TYPING: 'typing', READY: 'ready',
    SENT: 'sent', WRITING: 'writing', SETTLING: 'settling', PAUSED: 'paused', DONE: 'done',
  };

  const state = {
    items: [], activeId: null, phase: PHASE.IDLE, paused: true, phaseAt: now(),
    baselineAssistant: '', baselineUser: '', stableLength: -1, stableAt: 0,
    assignment: null, selectedChapterNumbers: null,
  };
  // These are internal safeguards, not settings the user has to tune. A
  // response must be visibly quiet for a moment after ChatGPT drops its Stop
  // button; then the next chapter starts automatically.
  const AUTO_QUIET_MS = 2500;
  const NEXT_CHAPTER_MS = 750;
  const MAX_AUTO_PDFS_PER_TAB = 12;

  // ---- ChatGPT page adapters ------------------------------------------------

  const selectors = {
    editor: '#prompt-textarea, div[contenteditable="true"].ProseMirror, div[role="textbox"]',
    send: 'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"]',
    stop: 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]',
    assistant: 'div[data-message-author-role="assistant"]',
    user: 'div[data-message-author-role="user"]',
    file: 'input[type="file"]',
  };
  const editor = () => $(selectors.editor);
  const sendButton = () => $(selectors.send);
  const isGenerating = () => !!$(selectors.stop);
  const assistants = () => {
    const found = $$(selectors.assistant);
    return found.length ? found : $$('div[data-message-id] div.markdown');
  };
  const users = () => $$(selectors.user);
  const chatFileInput = () => {
    const inputs = $$(selectors.file).filter(input => !input.closest('#aural-desk'));
    return inputs.find(input => input.id === 'upload-files') ||
      inputs.find(input => (input.accept || '').toLowerCase().includes('pdf')) || inputs[0] || null;
  };
  const nodeKey = (node) => {
    if (!node) return '';
    const id = node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (id) return `id:${id}`;
    const text = node.innerText || '';
    return `text:${text.length}:${text.slice(0, 60)}:${text.slice(-60)}`;
  };
  const lastAssistant = () => assistants().at(-1);
  const lastUser = () => users().at(-1);
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  function captureBaseline() {
    state.baselineAssistant = nodeKey(lastAssistant());
    state.baselineUser = nodeKey(lastUser());
    state.stableLength = -1;
    state.stableAt = 0;
  }
  function promptLeftComposer() {
    const key = nodeKey(lastUser());
    return !!key && key !== state.baselineUser;
  }
  function latestUserIs(item) {
    return !!item && clean(lastUser()?.innerText).includes(clean(item.prompt));
  }
  function responseVisible(item) {
    const assistant = lastAssistant();
    if (!assistant) return false;
    if (nodeKey(assistant) !== state.baselineAssistant) return true;
    const user = lastUser();
    return !!(item?.sentOnce && user && latestUserIs(item) &&
      (user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
  function insertText(text) {
    const box = editor();
    if (!box) return false;
    try {
      box.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      data.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      if (clean(box.innerText).includes(clean(text).slice(0, 50))) return true;
    } catch {}
    try {
      box.focus();
      // Keep the selection inside the composer. document.execCommand('selectAll')
      // can select the full conversation in a long chat and freeze the tab.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return clean(box.innerText).includes(clean(text).slice(0, 50));
    } catch { return false; }
  }

  // ---- persistence ----------------------------------------------------------

  function readSettings(done) {
    try {
      chrome.storage.local.get([SETTINGS_KEY, 'cgqrSettings'], data => {
        const saved = data[SETTINGS_KEY] || {};
        const old = data.cgqrSettings || {};
        // Migrate the old Aural GPT Script form, so a rebuild never makes the
        // user re-paste a huge master prompt, book link, or style sample.
        const migrated = {
          template: old.template, start: old.rangeStart, end: old.rangeEnd,
          harvest: old.harvest, sendSetup: old.sendSetupFirst, masterPrompt: old.masterPrompt,
          bookLinks: old.bookLink ? [old.bookLink, '', '', '', ''] : undefined, styleSample: old.styleSample, tabCount: old.tabCount,
        };
        Object.keys(migrated).forEach(key => migrated[key] === undefined && delete migrated[key]);
        settings = { ...DEFAULTS, ...migrated, ...saved };
        // Migrate v2.0's one Book link field to the new five-link list.
        if (!Array.isArray(settings.bookLinks)) settings.bookLinks = [saved.bookLink || old.bookLink || '', '', '', '', ''];
        settings.bookLinks = Array.from({ length: 5 }, (_, index) => settings.bookLinks[index] || '');
        // Keep the one-field setup message from the first v2 build as the
        // master prompt when upgrading to the restored Book Setup form.
        if (!settings.masterPrompt && saved.setup) settings.masterPrompt = saved.setup;
        done();
      });
    }
    catch { done(); }
  }
  function saveSettings() { try { chrome.storage.local.set({ [SETTINGS_KEY]: settings }); } catch {} }
  function openFolderDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(FOLDER_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(FOLDER_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function storeFolderHandle(handle) {
    const db = await openFolderDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(FOLDER_STORE, 'readwrite').objectStore(FOLDER_STORE).put(handle, FOLDER_RECORD);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    db.close();
  }
  async function getFolderHandle() {
    const db = await openFolderDb();
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction(FOLDER_STORE).objectStore(FOLDER_STORE).get(FOLDER_RECORD);
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  }
  async function folderPermission(handle, canAsk) {
    const options = { mode: 'read' };
    if (await handle.queryPermission(options) === 'granted') return true;
    return canAsk && await handle.requestPermission(options) === 'granted';
  }
  async function pdfFilesFromFolder(handle) {
    const files = [];
    for await (const entry of handle.values()) {
      if (entry.kind !== 'file' || !/\.pdf$/i.test(entry.name)) continue;
      files.push(await entry.getFile());
    }
    return files;
  }
  function persistRun() {
    try {
      sessionStorage.setItem(RUN_KEY, JSON.stringify({ items: state.items, activeId: state.activeId, assignment: state.assignment, selectedChapterNumbers: state.selectedChapterNumbers }));
    } catch {}
  }
  function restoreRun() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null');
      if (!saved?.items?.length) return false;
      state.items = saved.items;
      state.activeId = saved.activeId;
      state.assignment = saved.assignment || assignment;
      state.selectedChapterNumbers = saved.selectedChapterNumbers || null;
      state.phase = PHASE.PAUSED;
      state.paused = true;
      return true;
    } catch { return false; }
  }
  function saveChapter(number, text) {
    try { chrome.storage.local.set({ [CHAPTER_KEY + number]: { number, text, savedAt: now() } }, updateBook); } catch {}
  }
  function getBook(done) {
    try {
      chrome.storage.local.get(null, all => {
        // Keep scripts generated by the old extension version visible in the
        // new vault. New entries win if the same chapter exists in both.
        const byNumber = new Map();
        Object.keys(all).filter(key => key.startsWith(LEGACY_CHAPTER_KEY)).forEach(key => {
          const value = all[key];
          if (value?.text && Number.isFinite(value.n)) byNumber.set(value.n, { number: value.n, text: value.text, savedAt: value.at });
        });
        Object.keys(all).filter(key => key.startsWith(CHAPTER_KEY)).forEach(key => {
          const value = all[key];
          if (value?.text && Number.isFinite(value.number)) byNumber.set(value.number, value);
        });
        done([...byNumber.values()].sort((a, b) => a.number - b.number));
      });
    } catch { done([]); }
  }

  // ---- queue and batch assignment ------------------------------------------

  function loadAssignment() {
    const match = INITIAL_HASH.match(/#aural=(\d+)-(\d+)/);
    if (match) {
      assignment = { start: +match[1], end: +match[2] };
      try { sessionStorage.setItem(ASSIGNMENT_KEY, JSON.stringify(assignment)); } catch {}
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      try { assignment = JSON.parse(sessionStorage.getItem(ASSIGNMENT_KEY) || 'null'); } catch {}
    }
    state.assignment = assignment;
  }
  function rangeForThisTab() {
    if (state.assignment) return state.assignment;
    return { start: Math.min(settings.start, settings.end), end: Math.max(settings.start, settings.end) };
  }
  function composeBookSetup() {
    const parts = [];
    if (settings.masterPrompt.trim()) parts.push(settings.masterPrompt.trim());
    const links = settings.bookLinks.map(link => link.trim()).filter(Boolean);
    if (links.length) parts.push(`BOOK LINKS — use any working link for story context:\n${links.map((link, index) => `${index + 1}. ${link}`).join('\n')}`);
    if (settings.styleSample.trim()) parts.push(`STYLE SAMPLE:\n${settings.styleSample.trim()}`);
    return parts.join('\n\n');
  }
  function chapterNumberFromFileName(name) {
    const named = name.match(/(?:chapter|chap|ch)[\s_-]*(\d+)/i);
    if (named) return +named[1];
    const numbers = [...name.matchAll(/\d+/g)];
    return numbers.length ? +numbers.at(-1)[0] : null;
  }
  function makeQueue() {
    const range = rangeForThisTab();
    const items = [];
    const setup = composeBookSetup();
    if (settings.sendSetup && setup) items.push({ id: 'setup', label: 'Book setup', prompt: setup, setup: true, status: 'queued', attempts: 0 });
    const numbers = state.selectedChapterNumbers?.length
      ? state.selectedChapterNumbers
      : Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
    for (const number of numbers) {
      items.push({ id: `chapter-${number}`, number, label: `Chapter ${number}`, prompt: settings.template.replaceAll('{n}', String(number)), status: 'queued', attempts: 0 });
    }
    return items;
  }
  function beginWithSelectedFiles(files) {
    const assigned = rangeForThisTab();
    let numbers = [...new Set(files.map(file => chapterNumberFromFileName(file.name)).filter(Number.isFinite))].sort((a, b) => a - b);
    // When all PDFs are selected in a batch tab, retain only this tab's slice.
    const inThisTab = numbers.filter(number => number >= assigned.start && number <= assigned.end);
    if (state.assignment && inThisTab.length) numbers = inThisTab;
    state.selectedChapterNumbers = numbers.length ? numbers : null;
    if (numbers.length) note(`ChatGPT is uploading ${files.length} PDFs. This tab will run chapters ${numbers.join(', ')}.`);
    else note(`ChatGPT is uploading ${files.length} PDFs. Filenames had no chapter numbers, so this tab will run ${assigned.start}–${assigned.end}.`);
    beginFresh();
  }
  function filesForThisTab(files) {
    if (!state.assignment) return files;
    const assigned = rangeForThisTab();
    const matching = files.filter(file => {
      const number = chapterNumberFromFileName(file.name);
      return number != null && number >= assigned.start && number <= assigned.end;
    });
    return matching.length ? matching : files;
  }
  function injectFilesIntoChatGPT(files) {
    const input = chatFileInput();
    if (!input || !files.length) return false;
    try {
      const data = new DataTransfer();
      files.forEach(file => data.items.add(file));
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch { return false; }
  }
  async function waitForChatFileInput(maxWaitMs = 20000) {
    const deadline = now() + maxWaitMs;
    while (now() < deadline) {
      const input = chatFileInput();
      if (input) return input;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }
  let filePickerArmed = false;
  function attachPdfsAndBegin() {
    const input = chatFileInput();
    if (!input) return note('Could not find ChatGPT’s attachment input. Use ChatGPT’s + button, then press Begin (PDFs attached).');
    if (!filePickerArmed) {
      filePickerArmed = true;
      input.addEventListener('change', () => {
        filePickerArmed = false;
        const files = Array.from(input.files || []);
        if (files.length) beginWithSelectedFiles(files);
      }, { once: true });
      setTimeout(() => { filePickerArmed = false; }, 120000);
    }
    note('ChatGPT’s file picker is open. Select all PDFs for this tab.');
    input.click();
  }
  function beginWithAlreadyAttachedPdfs() {
    const files = Array.from(chatFileInput()?.files || []);
    if (files.length) beginWithSelectedFiles(files);
    else {
      state.selectedChapterNumbers = null;
      beginFresh();
      note('Started with the configured chapter range.');
    }
  }
  async function autoLoadFolderForThisTab(canAskPermission = false) {
    try {
      const folder = await getFolderHandle();
      if (!folder) return false;
      if (!await folderPermission(folder, canAskPermission)) return false;
      const allFiles = await pdfFilesFromFolder(folder);
      const files = filesForThisTab(allFiles);
      if (!files.length) { note('No PDFs were found for this tab’s chapter range.'); return false; }
      if (files.length > MAX_AUTO_PDFS_PER_TAB) {
        note(`This tab has ${files.length} PDFs. Split into more batches so each tab has at most ${MAX_AUTO_PDFS_PER_TAB}.`);
        return false;
      }
      if (!await waitForChatFileInput() || !injectFilesIntoChatGPT(files)) { note('ChatGPT’s upload input is not ready. Use Attach PDFs + Begin in this tab.'); return false; }
      beginWithSelectedFiles(files);
      note(`Auto-loaded ${files.length} PDFs from “${settings.folderName || folder.name}”.`);
      return true;
    } catch (error) {
      note(`Folder automation needs attention: ${error?.message || 'could not read the folder'}.`);
      return false;
    }
  }
  async function chooseFolderAndOpenBatches() {
    if (!window.showDirectoryPicker) return note('Folder automation requires Chrome or Edge. Use Attach PDFs + Begin instead.');
    try {
      const folder = await window.showDirectoryPicker({ mode: 'read' });
      if (!await folderPermission(folder, true)) return note('Folder access was not granted.');
      const files = await pdfFilesFromFolder(folder);
      if (!files.length) return note('That folder has no PDF files.');
      const neededBatches = Math.ceil(files.length / MAX_AUTO_PDFS_PER_TAB);
      if (settings.tabCount < neededBatches) {
        settings.tabCount = Math.min(12, neededBatches);
        saveSettings();
        note(`Using ${settings.tabCount} batch tabs to keep uploads at ${MAX_AUTO_PDFS_PER_TAB} PDFs or fewer per tab.`);
      }
      if (neededBatches > 12) return note(`This folder has ${files.length} PDFs. Use at least ${neededBatches} batches, which is above the current 12-tab safety limit.`);
      await storeFolderHandle(folder);
      settings.folderAutomation = true;
      settings.folderName = folder.name;
      saveSettings();
      openBatchTabs();
      await autoLoadFolderForThisTab(true);
    } catch (error) {
      if (error?.name !== 'AbortError') note(`Could not use that folder: ${error?.message || error}`);
    }
  }
  function splitRange(start, end, count) {
    const total = end - start + 1;
    const tabs = Math.max(1, Math.min(count, total));
    const base = Math.floor(total / tabs);
    let extra = total % tabs, current = start;
    return Array.from({ length: tabs }, () => {
      const length = base + (extra-- > 0 ? 1 : 0);
      const part = { start: current, end: current + length - 1 };
      current += length;
      return part;
    });
  }
  function openBatchTabs() {
    const full = { start: Math.min(settings.start, settings.end), end: Math.max(settings.start, settings.end) };
    const parts = splitRange(full.start, full.end, settings.tabCount);
    if (parts.length < 2) return note('Use at least two chapters to open a batch.');
    assignment = parts[0]; state.assignment = assignment;
    try { sessionStorage.setItem(ASSIGNMENT_KEY, JSON.stringify(assignment)); } catch {}
    const urls = parts.slice(1).map(part => `${location.origin}${location.pathname}#aural=${part.start}-${part.end}`);
    try { chrome.runtime.sendMessage({ type: 'openTabs', urls }); } catch { urls.forEach(url => window.open(url, '_blank')); }
    note(`Batch ready. This tab owns ${assignment.start}–${assignment.end}; the other tabs have their own ranges.`);
    render();
  }

  // ---- strict send-once engine ---------------------------------------------

  function active() { return state.items.find(item => item.id === state.activeId); }
  function setPhase(phase) { state.phase = phase; state.phaseAt = now(); render(); }
  function setFailure(item, message) {
    if (item) { item.status = 'failed'; item.error = message; }
    state.paused = true;
    setPhase(PHASE.PAUSED);
    persistRun();
    note(`Paused: ${message}`);
  }
  function beginFresh() {
    state.items = makeQueue();
    state.activeId = state.items[0]?.id || null;
    state.paused = false;
    if (!state.activeId) return note('There are no chapters in this range.');
    setPhase(PHASE.COOLDOWN);
    state.phaseAt = now() - NEXT_CHAPTER_MS;
    persistRun();
    note(`New run ready: ${state.items.filter(item => !item.setup).length} chapters. Each chapter can be sent only once.`);
  }
  function resume() {
    const item = active();
    if (!item) return beginFresh();
    if (item.status === 'failed') return note('If the finished panel script is visible, use Save answer + continue. Only use Retry chapter when you truly need a new generation.');
    state.paused = false;
    if (item.sentOnce || item.status === 'sent' || item.status === 'writing') {
      item.status = 'sent';
      item.sentAt ||= now();
      captureBaseline();
      setPhase(PHASE.SENT);
      note(`Watching ${item.label}; it will not be sent again.`);
    } else {
      setPhase(PHASE.COOLDOWN);
      state.phaseAt = now() - NEXT_CHAPTER_MS;
    }
    persistRun();
  }
  function startTyping(item) {
    if (isGenerating()) return;
    captureBaseline();
    item.status = 'typing';
    item.error = '';
    setPhase(PHASE.TYPING);
    if (!insertText(item.prompt)) return setFailure(item, 'ChatGPT input box was not found.');
    item.status = 'ready';
    setPhase(PHASE.READY);
    persistRun();
  }
  function commitSend(item) {
    const button = sendButton();
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    // This is the only automatic click for this attempt. The flag is saved
    // before the next engine tick, so a slow UI/reload cannot produce a second click.
    item.sentOnce = true;
    item.attempts = (item.attempts || 0) + 1;
    item.status = 'sent';
    item.sentAt = now();
    button.click();
    setPhase(PHASE.SENT);
    persistRun();
    note(`${item.label} sent once. Waiting for ChatGPT.`);
    return true;
  }
  function finishItem(item) {
    item.status = 'saved';
    item.finishedAt = now();
    const next = state.items.find(candidate => candidate.status === 'queued');
    state.activeId = next?.id || null;
    persistRun();
    if (!next) {
      state.paused = true;
      setPhase(PHASE.DONE);
      note('Run complete. Your chapters are in the Script Vault.');
      return;
    }
    setPhase(PHASE.COOLDOWN);
  }
  function retryCurrent() {
    const item = active();
    if (!item || item.status !== 'failed') return;
    // Retrying is intentional and always visibly recorded as a new attempt.
    item.status = 'queued'; item.sentOnce = false; item.error = '';
    state.paused = false;
    setPhase(PHASE.COOLDOWN);
    state.phaseAt = now() - NEXT_CHAPTER_MS;
    persistRun();
    note(`Manual retry armed for ${item.label} (attempt ${(item.attempts || 0) + 1}).`);
  }
  function skipCurrent() {
    const item = active();
    if (!item) return;
    item.status = 'skipped'; item.finishedAt = now();
    const next = state.items.find(candidate => candidate.status === 'queued');
    state.activeId = next?.id || null;
    persistRun();
    if (next) { state.paused = false; setPhase(PHASE.COOLDOWN); }
    else { state.paused = true; setPhase(PHASE.DONE); }
    note(`${item.label} skipped.`);
  }
  function extractPanels(text) {
    const match = text.match(/\[Panel\s*\d+\]/i);
    return match ? text.slice(match.index).trim() : '';
  }
  function latestPanelResponse(item) {
    // ChatGPT occasionally adds an empty assistant wrapper after its actual
    // answer. Always scan backwards for the latest message containing a panel
    // instead of trusting only the final wrapper.
    const expectedPrompt = clean(item?.prompt);
    const promptNode = expectedPrompt
      ? users().slice().reverse().find(node => clean(node.innerText).includes(expectedPrompt))
      : null;
    for (const node of assistants().slice().reverse()) {
      const text = node.innerText || node.textContent || '';
      const followsThisPrompt = !promptNode ||
        !!(promptNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (followsThisPrompt && extractPanels(text)) return { node, text };
    }
    return null;
  }
  function saveVisibleAnswerAndContinue() {
    const item = active();
    if (!item || item.setup) return;
    const answer = latestPanelResponse(item);
    const panels = answer && extractPanels(answer.text);
    if (!panels) return note('I cannot find a visible [Panel] script to save yet. Do not retry unless you truly want another generation.');
    item.status = 'saving';
    item.error = '';
    state.paused = false;
    saveChapter(item.number, panels);
    finishItem(item);
    note(`${item.label} saved from the visible answer. Continuing without a retry.`);
  }
  function tick() {
    if (state.paused) return;
    const item = active();
    if (!item) return;
    const elapsed = now() - state.phaseAt;
    try {
      if (state.phase === PHASE.COOLDOWN) {
        if (elapsed >= NEXT_CHAPTER_MS) startTyping(item);
        return;
      }
      if (state.phase === PHASE.READY) {
        if (commitSend(item)) return;
        return;
      }
      if (state.phase === PHASE.SENT) {
        if (isGenerating() || promptLeftComposer() || responseVisible(item)) { setPhase(PHASE.WRITING); return; }
        return;
      }
      if (state.phase === PHASE.WRITING) {
        if (!isGenerating()) { state.stableLength = -1; state.stableAt = now(); setPhase(PHASE.SETTLING); }
        return;
      }
      if (state.phase === PHASE.SETTLING) {
        if (isGenerating()) return setPhase(PHASE.WRITING);
        const panelAnswer = latestPanelResponse(item);
        const text = panelAnswer?.text || lastAssistant()?.innerText || '';
        if (text.length !== state.stableLength) { state.stableLength = text.length; state.stableAt = now(); }
        if ((!responseVisible(item) && !panelAnswer) || now() - state.stableAt < AUTO_QUIET_MS) return;
        if (item.setup || !settings.harvest) return finishItem(item);
        const panels = panelAnswer ? extractPanels(panelAnswer.text) : extractPanels(text);
        if (!panels) {
          return setFailure(item, 'ChatGPT finished but the answer has no [Panel] lines. It was not re-sent.');
        }
        saveChapter(item.number, panels);
        finishItem(item);
      }
    } catch (error) { setFailure(item, error?.message || 'Unexpected runner error.'); }
  }
  setInterval(() => { tick(); render(); }, 500);

  // ---- book actions ---------------------------------------------------------

  function updateBook() {
    getBook(chapters => {
      if (!ui.bookStatus) return;
      const expected = rangeForThisTab();
      const saved = new Set(chapters.map(chapter => chapter.number));
      let inRange = 0;
      for (let number = expected.start; number <= expected.end; number++) if (saved.has(number)) inRange++;
      ui.bookStatus.textContent = chapters.length
        ? `${chapters.length} saved total · ${inRange}/${expected.end - expected.start + 1} in this run`
        : 'No saved chapters yet';
    });
  }
  function copyBook() {
    getBook(chapters => {
      if (!chapters.length) return note('Nothing has been saved yet.');
      const text = chapters.map(chapter => chapter.text.trim()).join('\n\n') + '\n';
      navigator.clipboard?.writeText(text).then(() => note('Full script copied.'), () => note('Copy failed; use Download.'));
    });
  }
  function downloadBook() {
    getBook(chapters => {
      if (!chapters.length) return note('Nothing has been saved yet.');
      const url = URL.createObjectURL(new Blob([chapters.map(chapter => chapter.text.trim()).join('\n\n') + '\n'], { type: 'text/plain' }));
      const link = document.createElement('a'); link.href = url; link.download = 'aural-script.txt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  }
  function clearBook() {
    if (!clearBook.armed) {
      clearBook.armed = true; ui.clear.textContent = 'Click again to erase';
      setTimeout(() => { clearBook.armed = false; if (ui.clear) ui.clear.textContent = 'Clear vault'; }, 3500);
      return;
    }
    chrome.storage.local.get(null, all => {
      chrome.storage.local.remove(Object.keys(all).filter(key => key.startsWith(CHAPTER_KEY) || key.startsWith(LEGACY_CHAPTER_KEY)), () => { clearBook.armed = false; ui.clear.textContent = 'Clear vault'; updateBook(); note('Script Vault cleared.'); });
    });
  }

  // ---- UI -------------------------------------------------------------------

  function element(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    children.flat().filter(Boolean).forEach(child => node.append(typeof child === 'string' ? document.createTextNode(child) : child));
    return node;
  }
  function field(label, input) { return element('label', { class: 'ad-field' }, element('span', { text: label }), input); }
  function settingInput(type, value, attrs = {}) { return element('input', { class: 'ad-input', type, value: String(value), ...attrs }); }
  function bind(input, key, transform = value => value) {
    input.addEventListener('change', () => { settings[key] = transform(input.value); saveSettings(); updateBook(); });
  }
  function note(message) { if (ui.note) { ui.note.textContent = message; ui.note.classList.add('ad-note-show'); } }
  function buildUI() {
    const panel = element('aside', { id: 'aural-desk' });
    const collapse = element('button', { class: 'ad-icon', title: 'Collapse desk', text: '−' });
    const header = element('header', { class: 'ad-header' },
      element('div', { class: 'ad-mark', text: 'A' }),
      element('div', {}, element('div', { class: 'ad-eyebrow', text: 'Aural Studio' }), element('div', { class: 'ad-title', text: 'CHAPTER DESK' })),
      element('div', { class: 'ad-header-right' }, ui.dot = element('i', { class: 'ad-dot' }), collapse));
    const body = element('main', { class: 'ad-body' });
    collapse.addEventListener('click', () => { panel.classList.toggle('ad-collapsed'); collapse.textContent = panel.classList.contains('ad-collapsed') ? '+' : '−'; });
    panel.append(header, body); document.documentElement.append(panel);

    ui.assignment = element('div', { class: 'ad-assignment' }); body.append(ui.assignment);
    // Always-visible fields: this is where the book context belongs.
    const masterPrompt = element('textarea', { class: 'ad-input ad-textarea ad-master', placeholder: 'Paste your full master prompt here…' }); masterPrompt.value = settings.masterPrompt;
    const bookLinks = settings.bookLinks.map((link, index) => {
      const input = settingInput('url', link, { placeholder: index === 0 ? 'Paste primary book link here (https://…)' : `Optional book link ${index + 1} (https://…)` });
      input.addEventListener('change', () => { settings.bookLinks[index] = input.value.trim(); saveSettings(); });
      return input;
    });
    const styleSample = element('textarea', { class: 'ad-input ad-textarea ad-style', placeholder: 'Paste your example / style sample here…' }); styleSample.value = settings.styleSample;
    const setupOn = element('input', { type: 'checkbox' }); setupOn.checked = settings.sendSetup;
    bind(masterPrompt, 'masterPrompt'); bind(styleSample, 'styleSample');
    setupOn.addEventListener('change', () => { settings.sendSetup = setupOn.checked; saveSettings(); });
    body.append(element('section', { class: 'ad-card ad-book-setup' },
      element('div', { class: 'ad-card-row' }, element('div', { class: 'ad-card-title', text: 'Book setup' }), element('span', { class: 'ad-safe', text: 'SAVES AUTOMATICALLY' })),
      element('p', { class: 'ad-help', text: 'Paste your prompt and 1–5 book links here. ChatGPT receives every link and can use any one that works.' }),
      element('label', { class: 'ad-check' }, setupOn, ' Send Book Setup before chapter 1'),
      field('Master prompt', masterPrompt),
      field('Book links · fill 1–5 as needed', element('div', { class: 'ad-link-stack' }, bookLinks)),
      field('Style sample (optional)', styleSample)));
    ui.heroNumber = element('div', { class: 'ad-hero-number', text: '—' });
    ui.heroState = element('div', { class: 'ad-hero-state', text: 'Ready when you are' });
    ui.progress = element('div', { class: 'ad-progress-bar' });
    body.append(element('section', { class: 'ad-hero' }, element('div', { class: 'ad-hero-copy' }, element('span', { class: 'ad-kicker', text: 'Current mission' }), ui.heroNumber, ui.heroState), element('div', { class: 'ad-progress' }, ui.progress)));

    body.append(element('section', { class: 'ad-card ad-pdf-drop' },
      element('div', { class: 'ad-card-row' }, element('div', { class: 'ad-card-title', text: 'Chapter PDFs' }), element('span', { class: 'ad-safe', text: 'CHATGPT UPLOAD' })),
      element('p', { class: 'ad-help', text: 'Select all PDFs for this tab. Chapter numbers are read from their filenames, so a batch tab automatically keeps only its own chapters.' }),
      element('div', { class: 'ad-actions' },
        element('button', { class: 'ad-button ad-primary', text: 'Attach PDFs + Begin', onclick: attachPdfsAndBegin }),
        element('button', { class: 'ad-button ad-quiet', text: 'Begin (PDFs attached)', onclick: beginWithAlreadyAttachedPdfs }))));

    const template = settingInput('text', settings.template, { placeholder: 'go {n}' }); bind(template, 'template');
    const from = settingInput('number', settings.start, { min: '1' }); bind(from, 'start', value => Math.max(1, +value || 1));
    const to = settingInput('number', settings.end, { min: '1' }); bind(to, 'end', value => Math.max(1, +value || 1));
    const launch = element('button', { class: 'ad-button ad-primary', text: 'Start new run', onclick: beginFresh });
    ui.resume = element('button', { class: 'ad-button ad-secondary', text: 'Resume', onclick: resume });
    body.append(element('section', { class: 'ad-card' }, element('div', { class: 'ad-card-row' }, element('div', { class: 'ad-card-title', text: 'Queue builder' }), element('span', { class: 'ad-safe', text: 'AUTO-DETECT ANSWER' })), element('p', { class: 'ad-help', text: 'No delay, settle, or timeout settings. The next go prompt sends automatically after ChatGPT finishes and the answer stops changing.' }), field('Prompt template', template), element('div', { class: 'ad-grid' }, field('From', from), field('To', to)), element('div', { class: 'ad-actions' }, launch, ui.resume)));

    ui.retry = element('button', { class: 'ad-button ad-warning', text: 'Retry chapter', onclick: retryCurrent });
    ui.useVisible = element('button', { class: 'ad-button ad-primary', text: 'Save answer + continue', onclick: saveVisibleAnswerAndContinue });
    ui.skip = element('button', { class: 'ad-button ad-quiet', text: 'Skip', onclick: skipCurrent });
    ui.queue = element('div', { class: 'ad-queue' });
    body.append(element('section', { class: 'ad-card' }, element('div', { class: 'ad-card-row' }, element('div', { class: 'ad-card-title', text: 'Run monitor' }), element('span', { class: 'ad-safe', text: 'SEND ONCE' })), element('p', { class: 'ad-help', text: 'If a visible panel script was finished but detection missed it, save that answer and continue—do not spend credits on Retry.' }), element('div', { class: 'ad-actions' }, ui.useVisible, ui.retry, ui.skip), ui.queue));

    const tabs = element('select', { class: 'ad-input' }); Array.from({ length: 12 }, (_, index) => index + 1).forEach(number => tabs.append(element('option', { value: number, text: `${number} ${number === 1 ? 'tab' : 'tabs'}` }))); tabs.value = settings.tabCount;
    tabs.addEventListener('change', () => { settings.tabCount = +tabs.value; saveSettings(); });
    body.append(element('section', { class: 'ad-card ad-batch' }, element('div', { class: 'ad-card-row' }, element('div', { class: 'ad-card-title', text: 'Folder batch automation' }), element('span', { class: 'ad-safe', text: 'ONE FOLDER' })), element('p', { class: 'ad-help', text: 'Choose one PDF folder, choose how many tabs, and each tab receives only the PDFs for its chapter range.' }), element('div', { class: 'ad-actions' }, tabs, element('button', { class: 'ad-button ad-primary', text: 'Choose folder + auto-batch', onclick: chooseFolderAndOpenBatches }), element('button', { class: 'ad-button ad-quiet', text: 'Manual batch tabs', onclick: openBatchTabs }))));

    const harvest = element('input', { type: 'checkbox' }); harvest.checked = settings.harvest;
    harvest.addEventListener('change', () => { settings.harvest = harvest.checked; saveSettings(); });
    body.append(element('details', { class: 'ad-card ad-advanced' }, element('summary', { text: 'Automation options' }), element('div', { class: 'ad-details' }, element('label', { class: 'ad-check' }, harvest, ' Save [Panel] output into Script Vault'))));

    ui.bookStatus = element('div', { class: 'ad-book-status' });
    ui.clear = element('button', { class: 'ad-link ad-danger', text: 'Clear vault', onclick: clearBook });
    body.append(element('section', { class: 'ad-card ad-vault' }, element('div', { class: 'ad-card-row' }, element('div', { class: 'ad-card-title', text: 'Script Vault' }), ui.clear), ui.bookStatus, element('div', { class: 'ad-actions' }, element('button', { class: 'ad-button ad-primary', text: 'Copy full script', onclick: copyBook }), element('button', { class: 'ad-button ad-quiet', text: 'Download', onclick: downloadBook }))));
    ui.note = element('div', { class: 'ad-note', text: 'Upload PDFs through ChatGPT’s attachment button, then start your run.' }); body.append(ui.note);
  }
  function render() {
    if (!ui.heroNumber) return;
    const item = active();
    const total = state.items.filter(entry => !entry.setup).length;
    const complete = state.items.filter(entry => entry.status === 'saved' || entry.status === 'skipped').length - state.items.filter(entry => entry.setup && (entry.status === 'saved' || entry.status === 'skipped')).length;
    const phaseNames = { idle: 'Ready when you are', cooldown: 'Preparing next chapter', typing: 'Writing prompt', ready: 'Waiting for Send button', sent: 'Sent once · waiting for ChatGPT', writing: 'ChatGPT is writing', settling: 'Checking final response', paused: 'Paused safely', done: 'Run complete' };
    ui.heroNumber.textContent = item ? (item.setup ? 'SETUP' : `CHAPTER ${String(item.number).padStart(2, '0')}`) : (state.phase === PHASE.DONE ? 'COMPLETE' : '—');
    ui.heroState.textContent = phaseNames[state.phase] || 'Ready';
    ui.progress.style.width = total ? `${Math.max(0, complete) / total * 100}%` : '0%';
    ui.dot.className = `ad-dot ${state.paused ? 'ad-dot-paused' : state.phase === PHASE.DONE ? 'ad-dot-done' : 'ad-dot-live'}`;
    ui.assignment.textContent = state.assignment ? `This tab owns chapters ${state.assignment.start}–${state.assignment.end}` : `Workspace range: ${Math.min(settings.start, settings.end)}–${Math.max(settings.start, settings.end)}`;
    ui.retry.disabled = item?.status !== 'failed';
    ui.useVisible.disabled = item?.status !== 'failed' || item?.setup || !latestPanelResponse(item);
    ui.skip.disabled = !item || state.phase === PHASE.DONE;
    const recent = state.items.filter(entry => !entry.setup).slice(0, 12);
    ui.queue.replaceChildren(...recent.map(entry => element('div', { class: `ad-queue-row ad-${entry.status}` }, element('span', { text: `CH ${String(entry.number).padStart(2, '0')}` }), element('b', { text: entry.status === 'saved' ? 'saved' : entry.status === 'failed' ? 'needs you' : entry.status === 'sent' || entry.status === 'writing' ? 'in progress' : entry.status }))));
    const status = `${state.phase}:${item?.id || ''}:${complete}:${total}`;
    if (status !== lastStatus) { lastStatus = status; updateBook(); }
  }

  function boot() {
    readSettings(() => {
      loadAssignment();
      buildUI();
      const restored = restoreRun();
      if (!restored && state.assignment && settings.folderAutomation) {
        note(`Loading this tab’s assigned PDFs from “${settings.folderName || 'selected folder'}”…`);
        setTimeout(() => autoLoadFolderForThisTab(false), 800);
      } else {
        note(restored ? 'A previous run is restored safely. Resume watches an already-sent prompt; it does not re-send it.' : 'Upload PDFs through ChatGPT, set your range, then start a new run.');
      }
      try { chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && Object.keys(changes).some(key => key.startsWith(CHAPTER_KEY) || key.startsWith(LEGACY_CHAPTER_KEY))) updateBook(); }); } catch {}
      render(); updateBook();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
