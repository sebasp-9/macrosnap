/* MacroSnap — bring-your-own-key calorie & protein tracker (PWA) */
'use strict';

// Clickjacking defense-in-depth: refuse to run inside a frame.
// (frame-ancestors can't be set via <meta> on static hosting like GitHub Pages.)
if (window.top !== window.self) {
  try { window.top.location = window.location.href; }
  catch (e) { document.documentElement.style.display = 'none'; }
}

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

// How much history the app keeps. Anything older is deleted automatically (see
// pruneOldData): local storage stays small and old meals don't linger on the device.
const RETENTION_DAYS = 90; // ~3 months

// Coerce whatever is in storage / the settings form into a known-good shape.
// This is a security boundary: it whitelists `provider` against PROVIDERS (so an
// API key can never be sent to an endpoint we didn't intend), copies ONLY known
// keys (no prototype pollution or surprise fields from tampered storage), forces
// types, and bounds lengths/goals.
function normalizeSettings(raw) {
  const def = { provider: 'gemini', apiKey: '', model: '', calGoal: 2000, proGoal: 150 };
  if (!raw || typeof raw !== 'object') raw = {};
  const goal = (v, d) => { const n = num(v); return (n > 0 && n <= 100000) ? Math.round(n) : d; };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    provider: Object.prototype.hasOwnProperty.call(PROVIDERS, raw.provider) ? raw.provider : def.provider,
    apiKey: str(raw.apiKey, 500),
    model: str(raw.model, 100),
    calGoal: goal(raw.calGoal, def.calGoal),
    proGoal: goal(raw.proGoal, def.proGoal),
  };
}

function loadSettings() {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch { return normalizeSettings({}); }
}
// The API key is NEVER persisted to localStorage in plaintext — it's encrypted in
// IndexedDB via storeApiKey(). We strip it here so no code path can leak it to disk.
function saveSettingsObj(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, apiKey: '' })); }

function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '{}'); } catch { return {}; }
}
function saveLog(log) { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }

// ---------- Encrypted API-key storage (WebCrypto + IndexedDB) ----------
// The key is never stored in plaintext. A 256-bit AES-GCM key is generated as
// NON-EXTRACTABLE: script can decrypt with it but can't export its raw bytes, and
// it lives in IndexedDB (which a service worker/cache can't expose). Only the
// ciphertext + IV are persisted. The decrypted key exists in memory (settings.apiKey)
// for the session only. This removes plaintext-at-rest; it does not (and cannot)
// stop a live same-origin XSS — that's handled by the strict CSP + safe rendering.
const SECRET_DB = 'macrosnap-secret';
function cryptoOK() { return !!(window.crypto && window.crypto.subtle); }

function secretDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SECRET_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function secretGet(id) {
  return secretDB().then((db) => new Promise((res, rej) => {
    const r = db.transaction('kv', 'readonly').objectStore('kv').get(id);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  }));
}
function secretPut(rec) {
  return secretDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(rec);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function secretDelete(id) {
  return secretDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

// Get-or-create the non-extractable AES-GCM key (stored as a CryptoKey object).
async function getCryptoKey() {
  const existing = await secretGet('aeskey');
  if (existing && existing.key) return existing.key;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await secretPut({ id: 'aeskey', key });
  return key;
}

async function storeApiKey(plain) {
  if (!cryptoOK()) return; // non-secure context: key stays in memory only this session
  if (!plain) { await secretDelete('apikey'); return; }
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  await secretPut({ id: 'apikey', iv, data: ct });
}

async function loadApiKey() {
  if (!cryptoOK()) return '';
  try {
    const [rec, kr] = await Promise.all([secretGet('apikey'), secretGet('aeskey')]);
    if (!rec || !kr || !kr.key) return '';
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, kr.key, rec.data);
    return new TextDecoder().decode(pt);
  } catch { return ''; }
}

// Encrypt/decrypt anything else we keep on disk, reusing the same non-extractable key.
// Used for the offline queue, whose records can contain a photo of your food (and home).
async function encJSON(obj) {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, data };
}
async function decJSON(enc) {
  const key = await getCryptoKey();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.iv }, key, enc.data);
  return JSON.parse(new TextDecoder().decode(pt));
}

// Run once at startup: migrate any legacy plaintext key out of localStorage, then
// load the decrypted key into memory for this session.
async function initKey() {
  if (!cryptoOK()) return; // leave settings.apiKey as loaded (degraded, non-secure context)
  if (settings.apiKey) {
    // Legacy plaintext key found in localStorage → encrypt it, scrub the plaintext.
    await storeApiKey(settings.apiKey);
    saveSettingsObj(settings); // rewrites localStorage with apiKey:''
  } else {
    settings.apiKey = await loadApiKey();
  }
}

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
function formatBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

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
  $('nextDay').disabled = isToday(viewDate); // can't go past today
  $('prevDay').disabled = key <= retentionFloorKey(); // nothing older is kept

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
// Reflect whether a photo is attached: show/hide the preview and the note row.
function reflectPhotoState() {
  const has = !!pendingImage;
  $('previewImg').classList.toggle('hidden', !has);
  $('photoNote').classList.toggle('hidden', !has);
}

function openAddSheet() {
  pendingImage = null;
  $('descInput').value = '';
  $('previewImg').removeAttribute('src');
  $('resultBox').classList.add('hidden');
  $('analyzeStatus').classList.add('hidden');
  reflectPhotoState();
  $('addTitle').textContent = 'Add food';
  $('addSheet').classList.remove('hidden');
}
function closeAddSheet() { $('addSheet').classList.add('hidden'); }

// ---------- Photo intake ----------
// The copy we send is re-encoded at most IMG_MAX_EDGE px on its long side. 1024 is
// plenty for "what food is this" and keeps the upload (and the token bill) small.
const IMG_MAX_EDGE = 1024;
const IMG_QUALITY = 0.82;
const IMG_MAX_BYTES = 25 * 1024 * 1024;

// Decode a picked file to pixels, then re-encode it through a canvas.
// This is the privacy step. A canvas re-encode keeps ONLY the pixels, so the copy that
// leaves the device carries no EXIF whatsoever: no GPS coordinates, no capture time, no
// device serial, no embedded thumbnail. Gallery photos are usually full of that (a photo
// taken at home geotags your home), and camera shots often are too. Downscaling also
// bounds what we upload, so a 12 MP shot can't push a huge payload to the provider.
async function sanitizeImage(file) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error("That file isn't an image.");
  }
  if (file.size > IMG_MAX_BYTES) throw new Error('That image is too large (over 25 MB).');

  const src = await decodeImage(file);
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  if (typeof src.close === 'function') src.close(); // release the ImageBitmap

  const dataUrl = canvas.toDataURL('image/jpeg', IMG_QUALITY);
  const base64 = dataUrl.split(',')[1] || '';
  if (!base64) throw new Error("Couldn't process that image.");
  return { base64, mime: 'image/jpeg', dataUrl, w, h, bytes: Math.round((base64.length * 3) / 4) };
}

function decodeImage(file) {
  if (window.createImageBitmap) {
    // 'from-image' applies the EXIF orientation flag while decoding, so a portrait photo
    // doesn't come out sideways once we throw the metadata away.
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file))
      .catch(() => decodeViaImgEl(file));
  }
  return decodeViaImgEl(file);
}

// Fallback decoder. Deliberately routed through a data: URL rather than URL.createObjectURL:
// our CSP allows `img-src 'self' data:` and NOT blob:, and widening the CSP for a fallback
// path isn't worth it.
function decodeViaImgEl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Your browser couldn't decode that image. HEIC photos may need saving as JPEG first."));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Attach a photo to whatever is already in the open sheet (does NOT reset typed
// text or manual rows). Used by both the Camera and Gallery buttons.
async function handlePhoto(file) {
  setStatus('Preparing photo…', false);
  try {
    const img = await sanitizeImage(file);
    pendingImage = { base64: img.base64, mime: img.mime };
    $('previewImg').src = img.dataUrl;
    $('photoNoteText').textContent =
      `Metadata stripped · ${img.w}\u00d7${img.h} · ${formatBytes(img.bytes)}`;
    reflectPhotoState();
    setStatus('', false, true);
  } catch (err) {
    // sanitizeImage failed before touching pendingImage, so any photo
    // already attached stays attached.
    setStatus(err && typeof err.message === 'string' ? err.message : "Couldn't use that photo.", true);
  }
}

function clearPendingPhoto() {
  pendingImage = null;
  $('previewImg').removeAttribute('src');
  reflectPhotoState();
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
  const analyzeBtn = $('analyzeBtn');
  analyzeBtn.disabled = true;
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
    analyzeBtn.disabled = false;
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
  // The model's output is untrusted: tolerate any shape, then bound it so a
  // malformed/oversized response can't bloat storage or skew totals.
  const arr = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray(data.items) ? data.items : []);
  const amount = (v) => Math.max(0, Math.min(100000, num(v))); // finite, non-negative, capped
  return arr.slice(0, 50).filter((i) => i && typeof i === 'object').map((i) => ({
    name: String(i.name || i.food || 'Food').slice(0, 120),
    quantity: String(i.quantity || i.portion || '').slice(0, 120),
    calories: amount(i.calories ?? i.kcal ?? i.cal),
    protein: amount(i.protein_g ?? i.protein ?? i.proteinGrams),
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
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        // Key goes in a header, never the URL (avoids leaking it into logs/history).
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
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
  let detail;
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
  openAddSheet();
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
  const modelInput = $('modelInput');
  if (!modelInput.value.trim()) modelInput.placeholder = p.defaultModel;
}

async function saveSettings() {
  settings = normalizeSettings({
    provider: $('providerSel').value,
    apiKey: $('keyInput').value.trim(),
    model: $('modelInput').value.trim(),
    calGoal: $('calGoalInput').value,
    proGoal: $('proGoalInput').value,
  });
  await storeApiKey(settings.apiKey); // encrypt to IndexedDB (or clear if emptied)
  saveSettingsObj(settings);          // localStorage WITHOUT the key
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

// A queued meal can sit on disk for days and may hold a photo of your food and your home,
// so it goes in encrypted with the same non-extractable key the API key uses: only
// ciphertext reaches IndexedDB. Without WebCrypto (non-secure context) we degrade to
// plaintext rather than lose the meal.
async function enqueue(text, image) {
  const base = { id: uid(), date: dateKey(viewDate), ts: Date.now() };
  if (cryptoOK()) {
    try {
      await idbAdd({ ...base, enc: await encJSON({ text: text || '', image: image || null }) });
      await refreshQueueBadge();
      return;
    } catch { /* fall through to plaintext */ }
  }
  await idbAdd({ ...base, text: text || '', image: image || null });
  await refreshQueueBadge();
}

// Read one queued record. New records are encrypted; anything queued before this change
// is still plaintext, so handle both.
async function readQueueRec(q) {
  if (q && q.enc) { try { return await decJSON(q.enc); } catch { return null; } }
  return { text: (q && q.text) || '', image: (q && q.image) || null };
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
      const payload = await readQueueRec(q);
      if (!payload) { await idbDelete(q.id); continue; } // undecryptable, drop it
      try {
        const results = await callProvider(payload.text, payload.image);
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

// ---------- Recap (week / month) ----------
function statsFor(daysBack) {
  daysBack = Math.min(daysBack, RETENTION_DAYS); // nothing older than the window exists
  const log = loadLog();
  const today = new Date();
  let totalCal = 0, totalPro = 0, daysLogged = 0;
  const perDay = [];
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const items = log[dateKey(d)] || [];
    const cal = items.reduce((s, x) => s + num(x.calories), 0);
    const pro = items.reduce((s, x) => s + num(x.protein), 0);
    if (items.length) { daysLogged++; totalCal += cal; totalPro += pro; }
    perDay.push({ d, cal, pro, logged: items.length > 0 });
  }
  return { totalCal, totalPro, daysLogged, perDay };
}

function openRecap() {
  const avg = (t, n) => (n ? Math.round(t / n) : null);
  const fmt = (v) => (v == null ? '—' : v.toLocaleString());
  const block = (title, sub, s) => `
    <div class="recap-block">
      <div class="recap-h">${title} <span>${sub}</span></div>
      <div class="recap-stats">
        <div><b>${fmt(avg(s.totalCal, s.daysLogged))}</b><span>avg kcal/day</span></div>
        <div><b>${fmt(avg(s.totalPro, s.daysLogged))}</b><span>avg g protein/day</span></div>
        <div><b>${s.daysLogged}</b><span>days logged</span></div>
      </div>
    </div>`;

  const wk = statsFor(7);
  const mo = statsFor(30);
  const qtr = statsFor(RETENTION_DAYS);
  const maxCal = Math.max(settings.calGoal || 1, ...wk.perDay.map((p) => p.cal), 1);
  const days = wk.perDay.map((p) => {
    const label = isToday(p.d) ? 'Today' : p.d.toLocaleDateString(undefined, { weekday: 'short' });
    const pct = Math.max(0, Math.min(100, (p.cal / maxCal) * 100));
    // width is set via CSSOM below (no inline style attribute — keeps the CSP strict)
    return `<li class="recap-day">
      <span class="rd-day">${label}</span>
      <div class="rd-bar"><div data-pct="${pct}"></div></div>
      <span class="rd-val">${p.logged ? Math.round(p.cal) : '—'}</span>
    </li>`;
  }).join('');

  const recapBody = $('recapBody');
  recapBody.innerHTML =
    block('This week', 'last 7 days', wk) +
    block('This month', 'last 30 days', mo) +
    block('Last 3 months', 'last ' + RETENTION_DAYS + ' days', qtr) +
    `<div class="recap-block">
      <div class="recap-h">Daily calories <span>last 7 days</span></div>
      <ul class="recap-days">${days}</ul>
    </div>`;
  recapBody.insertAdjacentHTML('beforeend',
    '<p class="recap-foot">Showing the last ' + RETENTION_DAYS +
    ' days. Older entries are deleted automatically.</p>');
  // Apply bar widths programmatically (allowed by CSP; inline style attributes are not).
  recapBody.querySelectorAll('.rd-bar > div').forEach((el) => {
    el.style.width = (parseFloat(el.dataset.pct) || 0) + '%';
  });
  $('recapSheet').classList.remove('hidden');
}

// ---------- Retention ----------
// Date keys are zero-padded YYYY-MM-DD, so a plain string compare is a date compare.
const DATE_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
function retentionFloor() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (RETENTION_DAYS - 1)); // today counts as day 1 of the window
  return d;
}
function retentionFloorKey() { return dateKey(retentionFloor()); }

// Delete everything outside the window: log days, request counts, queued meals. Keys that
// aren't well-formed dates go too, since they can only be junk or tampering.
// Runs at startup and whenever the app returns to the foreground, so a PWA left open
// across a day boundary still prunes.
async function pruneOldData() {
  const floor = retentionFloorKey();

  const log = loadLog();
  let dropped = 0;
  for (const k of Object.keys(log)) {
    if (!DATE_KEY_RE.test(k) || k < floor) { delete log[k]; dropped++; }
  }
  if (dropped) saveLog(log);

  const counts = loadReq();
  let cDropped = 0;
  for (const k of Object.keys(counts)) {
    if (!DATE_KEY_RE.test(k) || k < floor) { delete counts[k]; cDropped++; }
  }
  if (cDropped) localStorage.setItem(REQ_KEY, JSON.stringify(counts));

  try {
    const cutoff = retentionFloor().getTime();
    for (const q of await idbGetAll()) {
      if (typeof q.ts === 'number' && q.ts < cutoff) await idbDelete(q.id);
    }
  } catch { /* queue unavailable, nothing to prune */ }

  return dropped;
}

// ---------- Wire up ----------
async function init() {
  // Provider model placeholder defaults
  $('providerSel').addEventListener('change', () => {
    const modelInput = $('modelInput');
    modelInput.value = '';
    modelInput.placeholder = PROVIDERS[$('providerSel').value].defaultModel;
    updateProviderHelp();
  });

  // Two photo sources. The gallery input has no 'capture' attribute, and that omission is
  // exactly what makes the OS offer the photo library instead of jumping to the camera.
  ['cameraInput', 'galleryInput'].forEach((id) => {
    $(id).onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = ''; // let the same file be picked again
      if (f) handlePhoto(f);
    };
  });
  $('cameraBtn').onclick = () => $('cameraInput').click();
  $('galleryBtn').onclick = () => $('galleryInput').click();
  $('removePhotoBtn').onclick = clearPendingPhoto;
  $('describeBtn').onclick = () => openAddSheet();
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

  $('prevDay').onclick = () => {
    if (dateKey(viewDate) <= retentionFloorKey()) return; // don't walk into deleted days
    viewDate.setDate(viewDate.getDate() - 1);
    render();
  };
  $('nextDay').onclick = () => { if (!isToday(viewDate)) { viewDate.setDate(viewDate.getDate() + 1); render(); } };
  $('dayLabel').onclick = () => { viewDate = new Date(); render(); };

  $('recapBtn').onclick = openRecap;
  $('closeRecap').onclick = () => $('recapSheet').classList.add('hidden');

  // Close sheets when tapping the dark backdrop
  document.querySelectorAll('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.classList.add('hidden'); });
  });

  setupMic();
  $('retentionDays').textContent = RETENTION_DAYS;
  await initKey(); // decrypt key into memory (and migrate any legacy plaintext key)
  await pruneOldData(); // enforce the retention window before anything is shown
  render();
  updateReqCount();
  refreshQueueBadge();

  // A PWA can stay open for days; re-prune when it returns to the foreground so the
  // window keeps moving without needing a restart.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pruneOldData().then((n) => { if (n) render(); });
  });

  // Process any queued meals when connectivity returns (and once on load).
  window.addEventListener('online', processQueue);
  processQueue();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
