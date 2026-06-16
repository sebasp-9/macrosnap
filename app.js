/* MacroSnap — bring-your-own-key calorie & protein tracker (PWA) */
'use strict';

// ---------- Config ----------
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    keyHelp: 'Get a free key at aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    keyHelp: 'Get a key at platform.openai.com/api-keys (pay-as-you-go)',
  },
  claude: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-opus-4-8',
    keyHelp: 'Get a key at console.anthropic.com. Cheaper: claude-haiku-4-5',
  },
};

const SYSTEM_PROMPT =
  'You are a nutrition estimator. From the food photo and/or text description, identify each distinct food item and estimate its nutrition for the portion shown. ' +
  'Respond ONLY with a JSON object of the form {"items":[{"name":string,"quantity":string,"calories":number,"protein_g":number}]}. ' +
  'calories is kcal for that portion; protein_g is grams. Use realistic estimates. If you truly cannot tell, return {"items":[]}.';

// ---------- Storage ----------
const SETTINGS_KEY = 'macrosnap.settings';
const LOG_KEY = 'macrosnap.log'; // { 'YYYY-MM-DD': [ {id,name,quantity,calories,protein,ts} ] }

function loadSettings() {
  const def = { provider: 'gemini', apiKey: '', model: '', calGoal: 2000, proGoal: 150 };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch { return def; }
}
function saveSettingsObj(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '{}'); } catch { return {}; }
}
function saveLog(log) { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }

// ---------- State ----------
let settings = loadSettings();
let viewDate = new Date();
let pendingImage = null; // { base64, mime }

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isToday(d) { return dateKey(d) === dateKey(new Date()); }
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ---------- Rendering ----------
function render() {
  const key = dateKey(viewDate);
  const items = (loadLog()[key] || []);

  const cal = items.reduce((s, i) => s + num(i.calories), 0);
  const pro = items.reduce((s, i) => s + num(i.protein), 0);

  $('calNow').textContent = Math.round(cal);
  $('proNow').textContent = Math.round(pro);
  $('calGoal').textContent = settings.calGoal;
  $('proGoal').textContent = settings.proGoal;
  $('calBar').style.width = Math.min(100, (cal / (settings.calGoal || 1)) * 100) + '%';
  $('proBar').style.width = Math.min(100, (pro / (settings.proGoal || 1)) * 100) + '%';

  $('dayLabel').textContent = isToday(viewDate)
    ? 'Today'
    : viewDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const list = $('logList');
  list.innerHTML = '';
  items.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `
      <div class="li-main">
        <div class="li-name"></div>
        <div class="li-sub"></div>
      </div>
      <div class="li-macros">
        <div class="li-cal">${Math.round(num(it.calories))} kcal</div>
        <div class="li-pro">${Math.round(num(it.protein))} g</div>
      </div>
      <button class="li-del" aria-label="Delete">✕</button>`;
    li.querySelector('.li-name').textContent = it.name || 'Food';
    li.querySelector('.li-sub').textContent = it.quantity || '';
    li.querySelector('.li-del').onclick = () => deleteItem(key, it.id);
    list.appendChild(li);
  });
  $('emptyLog').classList.toggle('hidden', items.length > 0);
  $('setupHint').classList.toggle('hidden', !!settings.apiKey);
}

function deleteItem(key, id) {
  const log = loadLog();
  log[key] = (log[key] || []).filter((i) => i.id !== id);
  saveLog(log);
  render();
}

// ---------- Add-food sheet ----------
function openAddSheet(withPhoto) {
  pendingImage = null;
  $('descInput').value = '';
  $('previewImg').classList.add('hidden');
  $('resultBox').classList.add('hidden');
  $('analyzeStatus').classList.add('hidden');
  $('addTitle').textContent = withPhoto ? 'Photo of meal' : 'Add food';
  $('addSheet').classList.remove('hidden');
}
function closeAddSheet() { $('addSheet').classList.add('hidden'); }

function handlePhoto(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const mime = (dataUrl.match(/^data:(.*?);base64,/) || [])[1] || 'image/jpeg';
    pendingImage = { base64: dataUrl.split(',')[1], mime };
    $('previewImg').src = dataUrl;
    $('previewImg').classList.remove('hidden');
    openAddSheet(true);
  };
  reader.readAsDataURL(file);
}

// ---------- AI analysis ----------
async function analyze() {
  if (!settings.apiKey) { openSettings(); return; }
  const text = $('descInput').value.trim();
  if (!text && !pendingImage) {
    setStatus('Add a photo or a description first.', true);
    return;
  }
  // Offline: stash the meal and analyze it automatically once back online.
  if (!navigator.onLine) {
    await enqueue(text, pendingImage);
    closeAddSheet();
    showToast("Saved offline — I'll analyze it when you're back online.");
    return;
  }

  setStatus('Analyzing…', false);
  $('analyzeBtn').disabled = true;
  try {
    const items = await callProvider(text, pendingImage);
    showResults(items);
    setStatus('', false, true);
  } catch (err) {
    // A network failure (not an API error) — queue it for retry.
    if (err && err.name === 'TypeError') {
      await enqueue(text, pendingImage);
      closeAddSheet();
      showToast('Connection failed — saved offline to analyze later.');
    } else {
      setStatus(typeof err?.message === 'string' ? err.message : 'Something went wrong.', true);
    }
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

function setStatus(msg, isError, hide) {
  const el = $('analyzeStatus');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.toggle('hidden', !!hide || !msg);
}

// Robustly pull a JSON object out of model text.
function parseItems(text) {
  if (!text) return [];
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  let data;
  try { data = JSON.parse(t); } catch { return []; }
  const arr = Array.isArray(data) ? data : (data.items || []);
  return arr.map((i) => ({
    name: String(i.name || i.food || 'Food'),
    quantity: String(i.quantity || i.portion || ''),
    calories: num(i.calories ?? i.kcal ?? i.cal),
    protein: num(i.protein_g ?? i.protein ?? i.proteinGrams),
  }));
}

async function callProvider(text, image) {
  bumpRequestCount(); // count every real request against the daily free-tier budget
  const userText = text || 'Identify the food in this photo and estimate calories and protein.';
  const p = settings.provider;
  const model = settings.model || PROVIDERS[p].defaultModel;

  if (p === 'gemini') {
    const parts = [{ text: userText }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      }
    );
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    const out = data.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '';
    return parseItems(out);
  }

  if (p === 'openai') {
    const content = [{ type: 'text', text: userText }];
    if (image) content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    return parseItems(data.choices?.[0]?.message?.content || '');
  }

  if (p === 'claude') {
    const content = [{ type: 'text', text: userText }];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseItems(out);
  }

  throw new Error('Unknown provider');
}

async function errText(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || j?.error?.type || JSON.stringify(j);
  } catch { detail = await res.text().catch(() => ''); }

  switch (res.status) {
    case 400:
      return `The request was rejected (400). Often a wrong model name for your plan. ${detail}`.slice(0, 240);
    case 401:
    case 403:
      return 'Your API key was rejected. Open ⚙︎ Settings and check the key matches the selected provider.';
    case 404:
      return `Model not found. Check the model name in Settings. ${detail}`.slice(0, 200);
    case 429:
      return 'Free-tier rate limit reached — wait a minute and try again. (Or in Settings, switch to a lighter model like gemini-2.0-flash-lite.)';
    case 500:
    case 503:
      return 'The AI provider is temporarily busy. Try again in a moment.';
    default:
      return `${res.status} ${res.statusText} ${detail}`.slice(0, 240);
  }
}

// ---------- Editable results ----------
function showResults(items) {
  const box = $('resultBox');
  const list = $('resultList');
  list.innerHTML =
    '<li class="result-head"><span>Item</span><span>kcal</span><span>protein</span><span></span></li>';
  if (!items.length) addResultRow({ name: '', quantity: '', calories: 0, protein: 0 });
  else items.forEach(addResultRow);
  box.classList.remove('hidden');
  recalcResults();
}

function addResultRow(it) {
  const li = document.createElement('li');
  li.className = 'result-row';
  li.innerHTML = `
    <input class="rr-name" type="text" placeholder="Food" />
    <input class="rr-cal" type="number" inputmode="numeric" />
    <input class="rr-pro" type="number" inputmode="numeric" />
    <button class="rr-del" aria-label="Remove">✕</button>`;
  li.querySelector('.rr-name').value = it.name || '';
  li.querySelector('.rr-cal').value = Math.round(num(it.calories));
  li.querySelector('.rr-pro').value = Math.round(num(it.protein));
  li.dataset.quantity = it.quantity || '';
  li.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', recalcResults));
  li.querySelector('.rr-del').onclick = () => { li.remove(); recalcResults(); };
  $('resultList').appendChild(li);
}

function readResultRows() {
  return [...document.querySelectorAll('.result-row')].map((li) => ({
    name: li.querySelector('.rr-name').value.trim() || 'Food',
    quantity: li.dataset.quantity || '',
    calories: num(li.querySelector('.rr-cal').value),
    protein: num(li.querySelector('.rr-pro').value),
  }));
}

function recalcResults() {
  const rows = readResultRows();
  $('resCal').textContent = Math.round(rows.reduce((s, r) => s + r.calories, 0));
  $('resPro').textContent = Math.round(rows.reduce((s, r) => s + r.protein, 0));
}

function saveResults() {
  const rows = readResultRows().filter((r) => r.calories || r.protein || r.name !== 'Food');
  if (!rows.length) { closeAddSheet(); return; }
  const log = loadLog();
  const key = dateKey(viewDate);
  log[key] = log[key] || [];
  rows.forEach((r) => log[key].push({ id: uid(), ...r, ts: Date.now() }));
  saveLog(log);
  closeAddSheet();
  render();
}

// ---------- Manual add ----------
function manualAdd() {
  openAddSheet(false);
  showResults([{ name: '', quantity: '', calories: 0, protein: 0 }]);
  $('analyzeStatus').classList.add('hidden');
}

// ---------- Voice (Web Speech API where available) ----------
let recognition = null;
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('micBtn');
  if (!SR) {
    // No in-app speech engine (typical on iOS Safari) — point to keyboard dictation.
    micBtn.onclick = () => { $('descInput').focus(); };
    micBtn.title = 'Tap the 🎤 on your keyboard to speak';
    return;
  }
  recognition = new SR();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  let baseText = '';
  recognition.onresult = (e) => {
    let t = '';
    for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    $('descInput').value = (baseText + ' ' + t).trim();
  };
  recognition.onend = () => micBtn.classList.remove('live');
  recognition.onerror = () => micBtn.classList.remove('live');
  micBtn.onclick = () => {
    if (micBtn.classList.contains('live')) { recognition.stop(); return; }
    baseText = $('descInput').value;
    try { recognition.start(); micBtn.classList.add('live'); } catch {}
  };
}

// ---------- Settings ----------
function openSettings() {
  $('providerSel').value = settings.provider;
  $('keyInput').value = settings.apiKey;
  $('modelInput').value = settings.model;
  $('calGoalInput').value = settings.calGoal;
  $('proGoalInput').value = settings.proGoal;
  updateProviderHelp();
  $('settingsSheet').classList.remove('hidden');
}
function closeSettings() { $('settingsSheet').classList.add('hidden'); }

function updateProviderHelp() {
  const p = PROVIDERS[$('providerSel').value];
  $('keyHelp').textContent = p.keyHelp;
  if (!$('modelInput').value.trim()) $('modelInput').placeholder = p.defaultModel;
}

function saveSettings() {
  settings = {
    provider: $('providerSel').value,
    apiKey: $('keyInput').value.trim(),
    model: $('modelInput').value.trim(),
    calGoal: num($('calGoalInput').value) || 2000,
    proGoal: num($('proGoalInput').value) || 150,
  };
  saveSettingsObj(settings);
  closeSettings();
  render();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ settings: { ...settings, apiKey: '' }, log: loadLog() }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'macrosnap-export.json';
  a.click();
}

// ---------- Daily request counter (free-tier budget awareness) ----------
const REQ_KEY = 'macrosnap.reqcount';
function loadReq() { try { return JSON.parse(localStorage.getItem(REQ_KEY) || '{}'); } catch { return {}; } }
function bumpRequestCount() {
  const c = loadReq();
  const k = dateKey(new Date());
  c[k] = (c[k] || 0) + 1;
  // keep only the last ~14 days
  const days = Object.keys(c).sort();
  while (days.length > 14) { delete c[days.shift()]; }
  localStorage.setItem(REQ_KEY, JSON.stringify(c));
  updateReqCount();
}
function updateReqCount() {
  const c = loadReq();
  $('reqCount').textContent = `🤖 ${c[dateKey(new Date())] || 0} AI requests today`;
}

// ---------- Offline queue (IndexedDB — holds photos too) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('macrosnap', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbAdd(rec) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put(rec);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGetAll() {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('queue', 'readonly').objectStore('queue').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
async function idbDelete(id) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function enqueue(text, image) {
  await idbAdd({ id: uid(), date: dateKey(viewDate), text: text || '', image: image || null, ts: Date.now() });
  await refreshQueueBadge();
}

async function refreshQueueBadge() {
  let n = 0;
  try { n = (await idbGetAll()).length; } catch {}
  $('queueCount').textContent = n;
  $('queueBadge').classList.toggle('hidden', n === 0);
}

let processing = false;
async function processQueue() {
  if (processing || !navigator.onLine || !settings.apiKey) return;
  let items = [];
  try { items = await idbGetAll(); } catch { return; }
  if (!items.length) return;
  processing = true;
  let logged = 0;
  try {
    for (const q of items) {
      try {
        const results = await callProvider(q.text, q.image);
        if (results.length) {
          const log = loadLog();
          log[q.date] = log[q.date] || [];
          results.forEach((r) => log[q.date].push({ id: uid(), ...r, ts: Date.now() }));
          saveLog(log);
          logged += results.length;
        }
        await idbDelete(q.id);
      } catch (e) {
        // Offline again or rate-limited — leave the rest queued and retry later.
        break;
      }
    }
  } finally {
    processing = false;
    await refreshQueueBadge();
    render();
    if (logged) showToast(`Logged ${logged} item(s) from your offline queue.`);
  }
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---------- Wire up ----------
function init() {
  // Provider model placeholder defaults
  $('providerSel').addEventListener('change', () => {
    $('modelInput').value = '';
    $('modelInput').placeholder = PROVIDERS[$('providerSel').value].defaultModel;
    updateProviderHelp();
  });

  $('photoBtn').onclick = () => $('photoInput').click();
  $('photoInput').onchange = (e) => { if (e.target.files[0]) handlePhoto(e.target.files[0]); e.target.value = ''; };
  $('describeBtn').onclick = () => openAddSheet(false);
  $('manualBtn').onclick = manualAdd;

  $('analyzeBtn').onclick = analyze;
  $('saveBtn').onclick = saveResults;
  $('addItemRow').onclick = () => { addResultRow({ name: '', calories: 0, protein: 0 }); };
  $('closeSheet').onclick = closeAddSheet;

  $('settingsBtn').onclick = openSettings;
  $('hintSettings').onclick = openSettings;
  $('saveSettings').onclick = saveSettings;
  $('closeSettings').onclick = closeSettings;
  $('exportData').onclick = exportData;

  $('prevDay').onclick = () => { viewDate.setDate(viewDate.getDate() - 1); render(); };
  $('dayLabel').onclick = () => { viewDate = new Date(); render(); };

  // Close sheets when tapping the dark backdrop
  document.querySelectorAll('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.classList.add('hidden'); });
  });

  setupMic();
  render();
  updateReqCount();
  refreshQueueBadge();

  // Process any queued meals when connectivity returns (and once on load).
  window.addEventListener('online', processQueue);
  processQueue();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
