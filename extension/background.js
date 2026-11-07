// Kendali background service worker (module).
// Connects to the local Kendali MCP server over WebSocket and executes browser tools.
import { GIFEncoder, quantize, applyPalette } from './lib/gifenc.esm.js';

const DEFAULT_PORT = 18765;
const VERSION = chrome.runtime.getManifest().version;
const INSTANCE = Math.random().toString(36).slice(2, 8); // identifies this service-worker lifetime
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// connection to the MCP server
// =====================================================================
let ws = null;
let connected = false;
let retry = 0;
let pingTimer = null;
let retryTimer = null;

async function getPort() {
  const { port } = await chrome.storage.local.get('port');
  return +port || DEFAULT_PORT;
}

// stable identity of this browser profile, so MCP clients can tell several browsers apart
async function identity() {
  let { deviceId, deviceName } = await chrome.storage.local.get(['deviceId', 'deviceName']);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  const pi = await chrome.runtime.getPlatformInfo();
  const os = { mac: 'macOS', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android' }[pi.os] || pi.os;
  const brand = (navigator.userAgentData?.brands || []).map((b) => b.brand).find((b) => !/not|chromium/i.test(b)) || 'Chrome';
  return { deviceId, name: deviceName || `${brand} on ${os} (${deviceId.slice(0, 4)})`, platform: os };
}

async function hello(s) {
  const id = await identity();
  if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'hello', version: VERSION, inst: INSTANCE, ...id }));
}

function badge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#16a34a' : '#6b7280' });
}

let connecting = false;
async function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
  connecting = true;
  clearTimeout(retryTimer);
  let s;
  try {
    const port = await getPort();
    // probe first: a failed fetch is silent, a failed WebSocket spams the extension's error log
    await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(2000) });
    s = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  } catch {
    return reschedule();
  } finally {
    connecting = false;
  }
  ws = s;
  s.onopen = () => {
    connected = true;
    retry = 0;
    badge(true);
    hello(s);
    // traffic keeps the MV3 service worker alive (Chrome 116+)
    clearInterval(pingTimer);
    pingTimer = setInterval(() => s.readyState === WebSocket.OPEN && s.send('{"type":"ping"}'), 20000);
  };
  s.onmessage = (e) => onMessage(s, e.data);
  s.onerror = () => {};
  s.onclose = (e) => {
    if (ws !== s) return;
    ws = null;
    connected = false;
    clearInterval(pingTimer);
    badge(false);
    reschedule();
  };
}

function reschedule() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(3000, 300 * 2 ** retry++));
}

// switch_browser: every connected browser shows a confirmation window; the one the user accepts wins
const pairWins = new Map(); // pair id -> windowId
async function openPairWindow(id) {
  const w = await chrome.windows.create({ url: chrome.runtime.getURL(`pair.html?id=${encodeURIComponent(id)}`), type: 'popup', width: 440, height: 300, focused: true });
  pairWins.set(id, w.id);
}
function closePairWindow(id) {
  const w = pairWins.get(id);
  pairWins.delete(id);
  if (w != null) chrome.windows.remove(w).catch(() => {});
}

function reply(sock, msg) {
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

async function onMessage(sock, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.type === 'pair') return openPairWindow(m.id);
  if (m.type === 'pair_done') return closePairWindow(m.id);
  if (!m.id || !m.tool) return;
  try {
    let result = await run(m.tool, m.args || {});
    if (typeof result === 'string') result = { text: result };
    reply(sock, { id: m.id, result });
  } catch (e) {
    reply(sock, { id: m.id, error: e?.message || String(e) });
  }
}

chrome.alarms.create('kendali-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg?.type === 'status') {
    Promise.all([getPort(), identity()]).then(([port, id]) => send({ connected, port, ...id }));
    return true;
  }
  if (msg?.type === 'setName') {
    chrome.storage.local.set({ deviceName: String(msg.name || '').trim().slice(0, 60) }).then(() => {
      if (ws) hello(ws);
      send({ ok: true });
    });
    return true;
  }
  if (msg?.type === 'pairAccept') {
    (async () => {
      if (msg.name) await chrome.storage.local.set({ deviceName: String(msg.name).trim().slice(0, 60) });
      const id = await identity();
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pair_accept', id: msg.id, name: id.name }));
      send({ ok: !!ws });
    })();
    return true;
  }
  if (msg?.type === 'setPort') {
    chrome.storage.local.set({ port: +msg.port || DEFAULT_PORT }).then(() => {
      ws?.close();
      ws = null;
      retry = 0;
      connect();
      send({ ok: true });
    });
    return true;
  }
});
badge(false);
connect();

// =====================================================================
// helpers
// =====================================================================
async function setLast(id) {
  await chrome.storage.session.set({ kdLast: id }).catch(() => {});
}
async function tabOf(a) {
  if (a.tabId != null) {
    let t;
    try { t = await chrome.tabs.get(+a.tabId); } catch { throw new Error(`tab ${a.tabId} not found — call tabs_context_mcp`); }
    setLast(t.id);
    return t;
  }
  // default: the tab Kendali used last, else the focused tab
  const { kdLast } = await chrome.storage.session.get('kdLast').catch(() => ({}));
  if (kdLast != null) {
    const t = await chrome.tabs.get(kdLast).catch(() => null);
    if (t) return t;
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (t) return t;
  const [t2] = await chrome.tabs.query({ active: true });
  if (t2) return t2;
  throw new Error('no active tab — call tabs_create_mcp');
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

async function waitLoad(tabId, timeout = 20000) {
  const end = Date.now() + timeout;
  await sleep(250);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('tab closed');
    if (t.status === 'complete') return t;
    await sleep(150);
  }
  return chrome.tabs.get(tabId);
}

function dialogGuard(tabId) {
  const d = dbg.get(tabId)?.dialog;
  if (d) throw new Error(`a JS ${d.type} dialog is open ("${d.message}") — call handle_dialog first`);
}

// run an op from content.js (isolated world)
async function page(tabId, op, a = {}) {
  dialogGuard(tabId);
  const go = async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (op, a) => globalThis.__kd(op, a),
      args: [op, a],
    });
    return r?.result;
  };
  // an alert()/confirm() opened by the action blocks the page script: notice it instead of hanging
  let poll;
  const dialogOpened = new Promise((res) => {
    poll = setInterval(() => { const d = dbg.get(tabId)?.dialog; if (d) res({ __dialog: d }); }, 150);
  });
  const v = await withTimeout(Promise.race([go(), dialogOpened]), (a.timeout || 0) + 30000,
    'page did not respond (a JS dialog may be open → handle_dialog, or the page is hung)').finally(() => clearInterval(poll));
  if (v?.__dialog) throw new Error(`a JS ${v.__dialog.type} dialog opened ("${v.__dialog.message}") — call handle_dialog`);
  if (v && v.__err) throw new Error(v.__err);
  return v;
}

async function b64ToBlob(data, mime) {
  return (await fetch(`data:${mime};base64,${data}`)).blob();
}
async function blobToB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more chars truncated)` : s);

// =====================================================================
// Chrome DevTools Protocol (chrome.debugger)
// =====================================================================
const dbg = new Map(); // tabId -> { console: [], net: Map, dialog, fresh }
const MAX_LOG = 1000;

async function attach(tabId) {
  if (dbg.has(tabId)) return dbg.get(tabId);
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    if (/already attached/i.test(e.message)) {
      // probably ours from before a service-worker restart: re-attach to rebuild state
      await chrome.debugger.detach(target).catch(() => {});
      try { await chrome.debugger.attach(target, '1.3'); } catch (e2) { throw new Error(`cannot debug tab ${tabId}: ${e2.message}`); }
    } else {
      throw new Error(`cannot control tab ${tabId}: ${e.message}`);
    }
  }
  const st = { console: [], net: new Map(), dialog: null, fresh: true };
  dbg.set(tabId, st);
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) {
    await chrome.debugger.sendCommand(target, m, {}).catch(() => {});
  }
  return st;
}

async function cdp(tabId, method, params = {}, timeout = 30000) {
  await attach(tabId);
  return withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), timeout, `${method} timed out`);
}

const fmtArg = (a) => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value))
  : a.unserializableValue || a.description || a.type;
const pushCap = (arr, x) => { arr.push(x); if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG); };

chrome.debugger.onEvent.addListener((src, method, p) => {
  const st = dbg.get(src.tabId);
  if (!st) return;
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushCap(st.console, { t: Date.now(), level: p.type, text: (p.args || []).map(fmtArg).join(' '), url: p.stackTrace?.callFrames?.[0]?.url || '' });
      break;
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails || {};
      pushCap(st.console, { t: Date.now(), level: 'exception', text: d.exception?.description || d.text, url: d.url || '' });
      break;
    }
    case 'Log.entryAdded':
      pushCap(st.console, { t: Date.now(), level: p.entry.level, text: p.entry.text, url: p.entry.url || '' });
      break;
    case 'Network.requestWillBeSent':
      st.net.set(p.requestId, { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type || '', status: null, t: Date.now() });
      if (st.net.size > MAX_LOG) st.net.delete(st.net.keys().next().value);
      break;
    case 'Network.responseReceived': {
      const r = st.net.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; r.type = p.type || r.type; }
      break;
    }
    case 'Network.loadingFailed': {
      const r = st.net.get(p.requestId);
      if (r) r.failed = p.errorText;
      break;
    }
    case 'Page.javascriptDialogOpening':
      st.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
      break;
    case 'Page.javascriptDialogClosed':
      st.dialog = null;
      break;
  }
});
chrome.debugger.onDetach.addListener((src) => dbg.delete(src.tabId));
chrome.tabs.onRemoved.addListener((id) => dbg.delete(id));

// ---- input -----------------------------------------------------------
const BTN = { left: 1, right: 2, middle: 4 };
const MODS = { alt: 1, option: 1, opt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8 };
const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9, '\t'], space: [' ', 'Space', 32, ' '],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], del: ['Delete', 'Delete', 46],
  escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], insert: ['Insert', 'Insert', 45],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  pgup: ['PageUp', 'PageUp', 33], pgdn: ['PageDown', 'PageDown', 34],
};
for (let i = 1; i <= 12; i++) KEYS['f' + i] = ['F' + i, 'F' + i, 111 + i];
const EDIT_CMDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

function parseMods(s) {
  let m = 0;
  for (const p of String(s || '').toLowerCase().split(/[+\s]+/)) if (MODS[p]) m |= MODS[p];
  return m;
}

function parseCombo(combo) {
  const parts = combo.split('+');
  let k = parts.pop();
  if (k === '' && parts.length) { parts.pop(); k = '+'; } // "ctrl++"
  let mods = 0;
  for (const p of parts) {
    const v = MODS[p.toLowerCase()];
    if (!v) throw new Error(`unknown modifier "${p}" in "${combo}"`);
    mods |= v;
  }
  const def = KEYS[k.toLowerCase()];
  if (def) return { key: def[0], code: def[1], keyCode: def[2], text: def[3], mods };
  if (k.length === 1) {
    const ch = mods & 8 ? k.toUpperCase() : k;
    const up = k.toUpperCase();
    const code = /[a-z]/i.test(k) ? 'Key' + up : /\d/.test(k) ? 'Digit' + k : '';
    const keyCode = /[a-z0-9]/i.test(k) ? up.charCodeAt(0) : 0;
    return { key: ch, code, keyCode, text: ch, mods };
  }
  return { key: k, code: k, keyCode: 0, mods };
}

async function pressKey(tabId, combo) {
  const k = parseCombo(combo);
  const text = k.mods & 7 ? undefined : k.text; // ctrl/alt/meta → no text insertion
  const cmd = k.mods & 6 && !(k.mods & 1) ? EDIT_CMDS[k.key.toLowerCase()] : undefined;
  const base = {
    key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.mods,
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, ...(cmd ? { commands: [cmd] } : {}),
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function mouse(tabId, type, x, y, o = {}) {
  const button = o.button || 'none';
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type, x, y, button, buttons: o.buttons ?? (type === 'mouseReleased' ? 0 : BTN[button] || 0),
    clickCount: o.clickCount || 0, modifiers: o.mods || 0, deltaX: o.dx || 0, deltaY: o.dy || 0,
  });
}

async function click(tabId, x, y, { button = 'left', count = 1, mods = 0 } = {}) {
  await mouse(tabId, 'mouseMoved', x, y, { mods, buttons: 0 });
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, 'mousePressed', x, y, { button, clickCount: i, mods });
    await mouse(tabId, 'mouseReleased', x, y, { button, clickCount: i, mods });
  }
}

async function viewport(tabId) {
  const m = await cdp(tabId, 'Page.getLayoutMetrics');
  const v = m.cssLayoutViewport || m.layoutViewport;
  return { w: v.clientWidth, h: v.clientHeight, content: m.cssContentSize || m.contentSize };
}

async function activate(tab) {
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }
}

async function screenshot(tab, a = {}) {
  const tabId = tab.id;
  await activate(tab);
  dialogGuard(tabId);
  const vp = await viewport(tabId);
  let params = { format: 'png' };
  if (a.full_page) {
    const c = vp.content;
    params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: c.width, height: Math.min(c.height, 12000), scale: 1 } };
  }
  const { data } = await cdp(tabId, 'Page.captureScreenshot', params, 60000);
  const bmp = await createImageBitmap(await b64ToBlob(data, 'image/png'));
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, ow, oh;
  if (a.region) {
    const [x0, y0, x1, y1] = a.region;
    const k = bmp.width / vp.w;
    sx = x0 * k; sy = y0 * k; sw = (x1 - x0) * k; sh = (y1 - y0) * k;
    ow = Math.max(1, Math.round(sw)); oh = Math.max(1, Math.round(sh));
  } else if (!a.full_page) {
    ow = vp.w; oh = vp.h; // CSS pixels → screenshot coords == click coords
  } else {
    const k = Math.min(1, 1600 / bmp.width);
    ow = Math.round(bmp.width * k); oh = Math.round(bmp.height * k);
  }
  const mime = a.format === 'png' ? 'image/png' : 'image/jpeg';
  const enc = async (w, h) => {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    return { data: await blobToB64(await canvas.convertToBlob({ type: mime, quality: a.quality ?? 0.8 })), mimeType: mime };
  };
  const full = await enc(ow, oh);
  let what = a.region ? `zoom of region [${a.region.join(',')}]` : a.full_page ? 'full-page screenshot' : `viewport screenshot (${ow}x${oh}; pixel coords = click coords)`;
  const scale = Math.min(1, Math.max(0.1, +a.scale || 1));
  if (scale < 1) {
    const w = Math.max(1, Math.round(ow * scale)), h = Math.max(1, Math.round(oh * scale));
    what += ` — image scaled to ${w}x${h}; coordinates stay in the full ${ow}x${oh} frame`;
    return { text: `${what} of tab ${tabId}: ${tab.title} | ${tab.url}`, image: await enc(w, h), full };
  }
  return { text: `${what} of tab ${tabId}: ${tab.title} | ${tab.url}`, image: full };
}

// =====================================================================
// tools
// =====================================================================
const T = {};

// Kendali keeps the tabs it opens in its own tab group (like Claude in Chrome's MCP group)
async function getGroup() {
  const { kdGroup } = await chrome.storage.session.get('kdGroup').catch(() => ({}));
  if (kdGroup == null) return null;
  return chrome.tabGroups.get(kdGroup).then(() => kdGroup, () => null);
}
async function groupTabs() {
  const g = await getGroup();
  return g == null ? [] : chrome.tabs.query({ groupId: g });
}
async function addToGroup(tabId) {
  let g = await getGroup();
  try {
    if (g != null) return await chrome.tabs.group({ groupId: g, tabIds: [tabId] });
    g = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(g, { title: 'Kendali', color: 'green' });
    await chrome.storage.session.set({ kdGroup: g });
    return g;
  } catch { return null; } // e.g. popup windows can't hold groups
}
async function ensureGroupTab() {
  const tabs = await groupTabs();
  if (tabs.length) return tabs;
  const w = await chrome.windows.create({ url: 'about:blank', focused: true });
  await addToGroup(w.tabs[0].id);
  await setLast(w.tabs[0].id);
  return groupTabs();
}

async function tabsContext() {
  const [tabs, mine, [focused]] = await Promise.all([chrome.tabs.query({}), groupTabs(), chrome.tabs.query({ active: true, lastFocusedWindow: true })]);
  const ids = new Set(mine.map((t) => t.id));
  const line = (t) => {
    const flags = [t.id === focused?.id ? 'FOCUSED' : t.active ? 'active' : '', t.status === 'loading' ? 'loading' : '', dbg.has(t.id) ? 'debug' : ''].filter(Boolean).join(',');
    return `  tabId ${t.id}${flags ? ` [${flags}]` : ''} ${(t.title || '').slice(0, 80)} | ${t.url || t.pendingUrl || ''}`;
  };
  const out = [mine.length ? `Kendali tab group (${mine.length} tab${mine.length > 1 ? 's' : ''}) — yours to use:` : 'Kendali tab group: none yet (tabs_create_mcp, or tabs_context_mcp {createIfEmpty:true})', ...mine.map(line)];
  const own = chrome.runtime.getURL('');
  const others = tabs.filter((t) => !ids.has(t.id) && !(t.url || t.pendingUrl || '').startsWith(own));
  if (others.length) out.push(`Other tabs (the user's — only use one if the user asks):`, ...others.map(line));
  return out.join('\n');
}

T.tabs_context_mcp = async (a) => {
  if (a.createIfEmpty) await ensureGroupTab();
  return tabsContext();
};

T.tabs_create_mcp = async (a) => {
  const g = await getGroup();
  let windowId;
  if (g != null) windowId = (await chrome.tabGroups.get(g)).windowId;
  else windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null))?.id;
  const t = await chrome.tabs.create({ url: a.url ? normUrl(a.url) : 'about:blank', active: a.active !== false, windowId });
  await addToGroup(t.id);
  await setLast(t.id);
  const done = a.url ? await waitLoad(t.id, a.timeout || 20000) : t;
  return `created tabId ${t.id} in the Kendali tab group: ${done.title || ''} | ${done.url || done.pendingUrl || ''}`;
};

T.tabs_close_mcp = async (a) => {
  const ids = [].concat(a.tabIds ?? a.tabId ?? []).map(Number);
  if (!ids.length) throw new Error('tabId or tabIds required');
  await chrome.tabs.remove(ids);
  return `closed ${ids.join(', ')}`;
};

T.tabs_switch = async (a) => {
  const t = await tabOf(a);
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  return `switched to tabId ${t.id}: ${t.title} | ${t.url}`;
};

function normUrl(u) {
  u = String(u).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return 'https://' + u;
}

T.navigate = async (a) => {
  const u = String(a.url || '').trim().toLowerCase();
  let tab, ctx = false;
  if (a.tabId == null && !['back', 'forward', 'reload'].includes(u)) {
    // like Claude in Chrome: no tabId → use (or create) a tab in Kendali's own group
    const mine = await ensureGroupTab();
    const { kdLast } = await chrome.storage.session.get('kdLast').catch(() => ({}));
    tab = mine.find((t) => t.id === kdLast) || mine[0];
    await setLast(tab.id);
    ctx = true;
  } else {
    tab = await tabOf(a);
  }
  if (u === 'back') await chrome.tabs.goBack(tab.id);
  else if (u === 'forward') await chrome.tabs.goForward(tab.id);
  else if (u === 'reload') await chrome.tabs.reload(tab.id, { bypassCache: !!a.hard });
  else await chrome.tabs.update(tab.id, { url: normUrl(a.url) });
  const t = await waitLoad(tab.id, a.timeout || 20000);
  const msg = `tabId ${t.id} ${t.status === 'complete' ? 'loaded' : 'still loading'}: ${t.title} | ${t.url}`;
  return ctx ? `${msg}\n\n${await tabsContext()}` : msg;
};

T.read_page = async (a) => {
  const tab = await tabOf(a);
  // Claude-in-Chrome params (filter/ref_id/depth/max_chars) read the whole page; Kendali's default is the viewport
  const whole = a.filter || a.ref_id != null || a.max_chars;
  const s = await page(tab.id, 'snap', {
    scope: a.scope || (whole ? 'all' : 'view'),
    max: a.max_lines || (whole ? 20000 : 150),
    text: a.include_text ?? a.filter === 'all',
    diff: !!a.diff, settle: true, root: a.ref_id, depth: a.depth, maxChars: a.max_chars || 50000,
  });
  return `tabId ${tab.id}\n${s}`;
};

T.find = async (a) => {
  const tab = await tabOf(a);
  return page(tab.id, 'find', { q: a.query });
};

T.get_page_text = async (a) => {
  const tab = await tabOf(a);
  return page(tab.id, 'read', { sel: a.selector, ref: a.ref, offset: a.offset, max: a.max_chars });
};

T.wait_for = async (a) => {
  const tab = await tabOf(a);
  if (a.text == null && a.selector == null) {
    await sleep(Math.min(+a.seconds || 1, 60) * 1000);
    return `waited ${a.seconds || 1}s`;
  }
  await page(tab.id, 'wait', { text: a.text, sel: a.selector, gone: !!a.gone, timeout: a.timeout || 10000 });
  return `ok: ${a.selector || `"${a.text}"`} ${a.gone ? 'gone' : 'present'}`;
};

async function doCdpAction(tabId, c) {
  if (c.type === 'click') await click(tabId, c.x, c.y);
  else if (c.type === 'hover') await mouse(tabId, 'mouseMoved', c.x, c.y);
  else if (c.type === 'key') await pressKey(tabId, c.key || 'Enter');
  else if (c.type === 'insert') {
    await cdp(tabId, 'Input.insertText', { text: c.text });
    if (c.submit) await pressKey(tabId, 'Enter');
  }
}

T.act = async (a) => {
  const tab = await tabOf(a);
  await attach(tab.id).catch(() => {});
  const args = { ...a, sel: a.selector };
  delete args.tabId;
  delete args.selector;
  delete args.snapshot;
  let r;
  try {
    r = await page(tab.id, 'act', args);
  } catch (e) {
    if (/frame|navigat|closed|removed|No tab/i.test(e.message)) return `${a.action} done — page navigated`;
    if (/dialog opened/.test(e.message)) return `${a.action} done\n⚠ ${e.message}`;
    throw e;
  }
  if (r?.cdp) await doCdpAction(tab.id, r.cdp);
  let out = r?.msg || `${a.action} done — page navigated`;
  if (a.snapshot !== false) {
    await sleep(200);
    const s = await page(tab.id, 'snap', { diff: true, settle: true }).catch(() => null);
    if (s) out += '\n' + s;
  }
  const d = dbg.get(tab.id)?.dialog;
  if (d) out += `\n⚠ JS ${d.type} dialog opened: "${d.message}" → handle_dialog`;
  return out;
};

T.form_input = async (a) => {
  const tab = await tabOf(a);
  const loc = { ref: a.ref, sel: a.selector };
  const mk = await page(tab.id, 'mark', loc);
  let action = 'fill';
  if (typeof a.value === 'boolean') action = a.value ? 'check' : 'uncheck';
  else if (mk.tag === 'SELECT') action = 'select';
  else if (mk.type === 'checkbox' || mk.type === 'radio') action = String(a.value) === 'false' ? 'uncheck' : 'check';
  const r = await page(tab.id, 'act', { ...loc, action, value: a.value });
  return r?.msg || 'ok';
};

T.computer = async (a) => {
  const tab = await tabOf(a);
  const id = tab.id;
  const act = a.action;
  if (act === 'screenshot') return screenshot(tab, a);
  if (act === 'zoom') {
    if (!a.region) throw new Error('zoom needs region [x0,y0,x1,y1]');
    return screenshot(tab, a);
  }
  if (act === 'wait') {
    await sleep(Math.min(+a.duration || 1, 30) * 1000);
    return `waited ${a.duration || 1}s`;
  }
  dialogGuard(id);
  if (act === 'type') {
    if (a.text == null) throw new Error('type needs text');
    await cdp(id, 'Input.insertText', { text: String(a.text) });
    return `typed ${String(a.text).length} chars`;
  }
  if (act === 'key') {
    if (!a.text) throw new Error('key needs text, e.g. "Enter", "ctrl+a", "cmd+shift+t", "Tab Tab Enter"');
    const n = Math.min(+a.repeat || 1, 100);
    for (let i = 0; i < n; i++) for (const combo of String(a.text).trim().split(/\s+/)) await pressKey(id, combo);
    return `pressed ${a.text}${n > 1 ? ` x${n}` : ''}`;
  }

  let [x, y] = a.coordinate || [];
  if (a.ref != null) {
    const r = await page(id, 'rect', { ref: a.ref });
    x = r.x + r.w / 2; y = r.y + r.h / 2;
  }
  if (act === 'scroll_to') {
    if (a.ref == null) throw new Error('scroll_to needs ref');
    return `scrolled ref ${a.ref} into view`;
  }
  if (act === 'scroll') {
    if (x == null) { const v = await viewport(id); x = v.w / 2; y = v.h / 2; }
    const amt = (+a.scroll_amount || 3) * 100;
    const dir = a.scroll_direction || 'down';
    const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
    const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
    await mouse(id, 'mouseMoved', x, y);
    await mouse(id, 'mouseWheel', x, y, { dx, dy });
    await sleep(250);
    return `scrolled ${dir} ${amt}px at (${Math.round(x)},${Math.round(y)})`;
  }
  if (x == null || y == null) throw new Error(`${act} needs coordinate [x,y] or ref`);
  const mods = parseMods(a.modifiers);
  switch (act) {
    case 'left_click': await click(id, x, y, { mods }); break;
    case 'right_click': await click(id, x, y, { button: 'right', mods }); break;
    case 'middle_click': await click(id, x, y, { button: 'middle', mods }); break;
    case 'double_click': await click(id, x, y, { count: 2, mods }); break;
    case 'triple_click': await click(id, x, y, { count: 3, mods }); break;
    case 'hover': case 'mouse_move': await mouse(id, 'mouseMoved', x, y, { mods }); break;
    case 'left_click_drag': {
      const [sx, sy] = a.start_coordinate || [];
      if (sx == null) throw new Error('left_click_drag needs start_coordinate and coordinate');
      await mouse(id, 'mouseMoved', sx, sy);
      await mouse(id, 'mousePressed', sx, sy, { button: 'left', clickCount: 1 });
      for (let i = 1; i <= 12; i++) {
        await mouse(id, 'mouseMoved', sx + ((x - sx) * i) / 12, sy + ((y - sy) * i) / 12, { button: 'left', buttons: 1 });
        await sleep(16);
      }
      await mouse(id, 'mouseReleased', x, y, { button: 'left', clickCount: 1 });
      break;
    }
    default: throw new Error(`unknown computer action "${act}"`);
  }
  await sleep(150);
  let out = `${act} at (${Math.round(x)},${Math.round(y)})`;
  const d = dbg.get(id)?.dialog;
  if (d) out += `\n⚠ JS ${d.type} dialog opened: "${d.message}" → handle_dialog`;
  return out;
};

T.javascript_tool = async (a) => {
  const tab = await tabOf(a);
  dialogGuard(tab.id);
  const timeout = Math.min(+a.timeout_ms || 30000, 300000);
  const r = await cdp(tab.id, 'Runtime.evaluate', {
    expression: String(a.code ?? a.text ?? ''), awaitPromise: true, returnByValue: true, replMode: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
  }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const v = r.result || {};
  let s;
  if (v.type === 'undefined') s = 'undefined';
  else if ('value' in v) s = typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 1);
  else s = v.description || v.type;
  return clip(String(s), +a.max_chars || 20000);
};

T.read_console_messages = async (a) => {
  const tab = await tabOf(a);
  const st = await attach(tab.id);
  const fresh = st.fresh; st.fresh = false;
  let list = st.console;
  if (a.only_errors || a.onlyErrors) list = list.filter((m) => /error|exception|assert/.test(m.level));
  if (a.pattern) { const re = new RegExp(a.pattern, 'i'); list = list.filter((m) => re.test(m.text) || re.test(m.url)); }
  const lim = +a.limit || 100;
  const out = list.slice(-lim).map((m) => `[${m.level}] ${clip(m.text || '', 500)}${m.url ? `  (${m.url.slice(0, 100)})` : ''}`);
  if (a.clear) st.console.length = 0;
  let head = `${list.length} message(s)${list.length > lim ? `, showing last ${lim}` : ''}`;
  if (fresh) head += ' — console tracking just started for this tab; reload the page to capture earlier logs';
  return [head, ...out].join('\n');
};

T.read_network_requests = async (a) => {
  const tab = await tabOf(a);
  const st = await attach(tab.id);
  if (a.request_id) {
    const r = await cdp(tab.id, 'Network.getResponseBody', { requestId: a.request_id });
    const body = r.base64Encoded ? `(base64, ${r.body.length} chars)\n${r.body}` : r.body;
    return clip(body, +a.max_chars || 20000);
  }
  const fresh = st.fresh; st.fresh = false;
  let list = [...st.net.values()];
  if (a.url_pattern) { const re = new RegExp(a.url_pattern, 'i'); list = list.filter((r) => re.test(r.url)); }
  if (a.urlPattern) list = list.filter((r) => r.url.includes(a.urlPattern));
  if (a.only_failed) list = list.filter((r) => r.failed || r.status >= 400);
  if (a.types) { const ty = [].concat(a.types).map((x) => x.toLowerCase()); list = list.filter((r) => ty.includes(r.type.toLowerCase())); }
  const lim = +a.limit || 100;
  const out = list.slice(-lim).map((r) => `${r.id} ${r.method} ${r.failed ? 'FAILED ' + r.failed : r.status ?? 'pending'} ${r.type} ${r.url.slice(0, 300)}`);
  if (a.clear) st.net.clear();
  let head = `${list.length} request(s)${list.length > lim ? `, showing last ${lim}` : ''} — pass request_id to read a response body`;
  if (fresh) head += '\n(network tracking just started for this tab; reload to capture earlier requests)';
  return [head, ...out].join('\n');
};

T.handle_dialog = async (a) => {
  const tab = await tabOf(a);
  const st = await attach(tab.id);
  const d = st.dialog;
  await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept: a.accept !== false, promptText: a.prompt_text });
  st.dialog = null;
  return `${a.accept !== false ? 'accepted' : 'dismissed'} ${d ? `${d.type} "${d.message}"` : 'dialog'}`;
};

T.file_upload = async (a) => {
  const tab = await tabOf(a);
  const paths = [].concat(a.paths || []);
  if (!paths.length) throw new Error('paths required (absolute local file paths)');
  const mk = await page(tab.id, 'mark', { ref: a.ref, sel: a.selector });
  if (mk.tag !== 'INPUT' || mk.type !== 'file') throw new Error(`${mk.what} is not <input type=file>; use find/read_page to locate the file input (often hidden — use its ref)`);
  const ev = await cdp(tab.id, 'Runtime.evaluate', { expression: `document.querySelector('[data-kd-mark="${mk.tok}"]')` });
  if (!ev.result?.objectId) throw new Error('could not resolve the file input in the page (inside iframe/shadow DOM?)');
  await cdp(tab.id, 'DOM.setFileInputFiles', { files: paths, objectId: ev.result.objectId });
  return `set ${paths.length} file(s) on ${mk.what}`;
};

T.resize_window = async (a) => {
  const tab = await tabOf(a);
  const w = await chrome.windows.update(tab.windowId, { state: 'normal', width: a.width ? +a.width : undefined, height: a.height ? +a.height : undefined });
  return `window ${w.id} is now ${w.width}x${w.height}`;
};

T.save_pdf = async (a) => {
  const tab = await tabOf(a);
  dialogGuard(tab.id);
  const r = await cdp(tab.id, 'Page.printToPDF', {
    printBackground: a.print_background !== false, landscape: !!a.landscape, preferCSSPageSize: true,
  }, 120000);
  return { text: `PDF of ${tab.title} | ${tab.url}`, file: { data: r.data, ext: 'pdf' } };
};

// ---- downloads -------------------------------------------------------
async function waitDownload(id, timeout) {
  const end = Date.now() + timeout;
  while (true) {
    const [d] = await chrome.downloads.search({ id });
    if (!d) throw new Error(`download ${id} disappeared`);
    if (d.state !== 'in_progress') return d;
    if (Date.now() > end) return d;
    await sleep(300);
  }
}
const fmtDl = (d) => `#${d.id} ${d.state}${d.error ? ' (' + d.error + ')' : ''} ${d.filename || '(pending)'} ← ${/^data:/.test(d.finalUrl || d.url) ? '(generated data)' : (d.finalUrl || d.url)}`.slice(0, 400)
  + (d.state === 'in_progress' && d.totalBytes > 0 ? ` ${Math.round((100 * d.bytesReceived) / d.totalBytes)}%` : '');

T.download = async (a) => {
  const id = await chrome.downloads.download({
    url: a.url, filename: a.filename || undefined, saveAs: false, conflictAction: 'uniquify',
    headers: a.headers ? Object.entries(a.headers).map(([name, value]) => ({ name, value: String(value) })) : undefined,
  });
  if (a.wait === false) return `started download #${id}`;
  return fmtDl(await waitDownload(id, a.timeout || 120000));
};

T.downloads = async (a) => {
  const action = a.action || 'list';
  if (action === 'list') {
    const items = await chrome.downloads.search({ query: a.query ? [a.query] : undefined, orderBy: ['-startTime'], limit: +a.limit || 20 });
    return items.length ? items.map(fmtDl).join('\n') : 'no downloads';
  }
  if (action === 'wait') {
    // wait for the most recent download started within since_seconds (e.g. after clicking a download link)
    const since = Date.now() - (+a.since_seconds || 30) * 1000;
    const end = Date.now() + (a.timeout || 120000);
    let d;
    while (!d && Date.now() < end) {
      [d] = await chrome.downloads.search({ startedAfter: new Date(since).toISOString(), orderBy: ['-startTime'], limit: 1 });
      if (!d) await sleep(300);
    }
    if (!d) throw new Error('no download started');
    return fmtDl(await waitDownload(d.id, Math.max(1000, end - Date.now())));
  }
  const id = +a.id;
  if (!id) throw new Error(`${action} needs id`);
  if (action === 'cancel') { await chrome.downloads.cancel(id); return `cancelled #${id}`; }
  if (action === 'erase') { await chrome.downloads.erase({ id }); return `erased #${id} from history`; }
  if (action === 'pause') { await chrome.downloads.pause(id); return `paused #${id}`; }
  if (action === 'resume') { await chrome.downloads.resume(id); return `resumed #${id}`; }
  if (action === 'show') { chrome.downloads.show(id); return `revealed #${id}`; }
  throw new Error(`unknown downloads action "${action}"`);
};

// ---- cookies / history ----------------------------------------------
T.cookies = async (a) => {
  const action = a.action || 'list';
  let url = a.url;
  if (!url && action !== 'list') url = (await tabOf(a)).url;
  if (action === 'list') {
    const q = {};
    if (a.url) q.url = a.url; else if (a.domain) q.domain = a.domain; else q.url = (await tabOf(a)).url;
    if (a.name) q.name = a.name;
    const cs = await chrome.cookies.getAll(q);
    return cs.length ? cs.map((c) => `${c.name}=${clip(c.value, 200)}  (domain=${c.domain} path=${c.path}${c.httpOnly ? ' httpOnly' : ''}${c.secure ? ' secure' : ''}${c.expirationDate ? ' exp=' + new Date(c.expirationDate * 1000).toISOString() : ' session'})`).join('\n') : 'no cookies';
  }
  if (action === 'set') {
    const c = await chrome.cookies.set({
      url, name: a.name, value: a.value ?? '', domain: a.domain, path: a.path, secure: a.secure, httpOnly: a.http_only,
      expirationDate: a.expires_days ? Date.now() / 1000 + a.expires_days * 86400 : undefined,
    });
    return c ? `set ${c.name} on ${c.domain}` : 'cookie rejected';
  }
  if (action === 'remove') {
    await chrome.cookies.remove({ url, name: a.name });
    return `removed ${a.name}`;
  }
  throw new Error(`unknown cookies action "${action}"`);
};

T.history = async (a) => {
  const items = await chrome.history.search({
    text: a.query || '', maxResults: +a.limit || 30, startTime: Date.now() - (+a.days || 7) * 86400000,
  });
  return items.length ? items.map((h) => `${new Date(h.lastVisitTime).toISOString().slice(0, 16)} ${(h.title || '').slice(0, 70)} | ${h.url}`).join('\n') : 'no history matches';
};

// ---- upload_image / gif ----------------------------------------------
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

async function reencode(data, from, to) {
  const bmp = await createImageBitmap(await b64ToBlob(data, from));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  return blobToB64(await c.convertToBlob({ type: to, quality: 0.92 }));
}

async function dropFile(a, data, mime, name) {
  const tab = await tabOf(a);
  if (a.ref == null && !a.coordinate) throw new Error('provide ref (file input or drop target) or coordinate [x,y] (drop location)');
  const [x, y] = a.coordinate || [];
  const r = await page(tab.id, 'drop', { ref: a.ref, x, y, b64: data, mime, name });
  return r.msg;
}

T.upload_image = async (a) => {
  const name = a.filename || 'image.png';
  let { data, mime } = a;
  const want = MIME_OF[(/\.(\w+)$/.exec(name)?.[1] || '').toLowerCase()];
  if (want && want !== mime && want !== 'image/gif') { data = await reencode(data, mime, want); mime = want; }
  return dropFile(a, data, mime, name);
};

T.gif_render = async (a) => {
  const o = { showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, showWatermark: true, quality: 10, ...(a.options || {}) };
  const frames = a.frames || [];
  if (!frames.length) throw new Error('no frames recorded');
  const bmps = await Promise.all(frames.map(async (f) => createImageBitmap(await b64ToBlob(f.data, f.mime || 'image/jpeg'))));
  const q = Math.min(30, Math.max(1, +o.quality || 10));
  const maxW = q <= 5 ? 1280 : q <= 15 ? 960 : 720;
  const W = Math.min(maxW, bmps[0].width);
  const H = Math.round((bmps[0].height * W) / bmps[0].width);
  const fmt = q <= 10 ? 'rgb565' : 'rgb444';
  const gif = GIFEncoder();
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], bmp = bmps[i];
    const k = Math.min(W / bmp.width, H / bmp.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(bmp, 0, 0, bmp.width * k, bmp.height * k);
    if (o.showDragPaths && f.drag) {
      const [[x0, y0], [x1, y1]] = f.drag.map(([x, y]) => [x * k, y * k]);
      ctx.strokeStyle = '#dc2626'; ctx.fillStyle = '#dc2626'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - 14 * Math.cos(ang - 0.4), y1 - 14 * Math.sin(ang - 0.4));
      ctx.lineTo(x1 - 14 * Math.cos(ang + 0.4), y1 - 14 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    }
    if (o.showClickIndicators && f.click) {
      const [x, y] = [f.click[0] * k, f.click[1] * k];
      ctx.fillStyle = 'rgba(249,115,22,0.35)'; ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (o.showActionLabels && f.label) {
      ctx.font = '600 15px system-ui, sans-serif';
      const text = f.label.length > 90 ? f.label.slice(0, 89) + '…' : f.label;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.beginPath(); ctx.roundRect(12, H - 52, tw + 24, 30, 8); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(text, 24, H - 32);
    }
    if (o.showProgressBar) {
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(0, H - 6, W, 6);
      ctx.fillStyle = '#f97316'; ctx.fillRect(0, H - 6, (W * (i + 1)) / frames.length, 6);
    }
    if (o.showWatermark) {
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(22,163,74,0.85)';
      ctx.fillText('Kendali', W - ctx.measureText('Kendali').width - 12, 22);
    }
    const { data } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(data, 256, { format: fmt });
    const index = applyPalette(data, palette, fmt);
    const delay = i === frames.length - 1 ? 2500 : f.label ? 1300 : 900;
    gif.writeFrame(index, W, H, { palette, delay });
  }
  gif.finish();
  const b64 = await blobToB64(new Blob([gif.bytes()], { type: 'image/gif' }));
  const name = a.filename || `recording-${Date.now()}.gif`;
  const info = `GIF: ${frames.length} frames, ${W}x${H}, ${Math.round((b64.length * 3) / 4 / 1024)} KB`;
  if (a.drop) return `${info}\n${await dropFile(a.drop, b64, 'image/gif', name)}`;
  if (a.download) {
    const id = await chrome.downloads.download({ url: `data:image/gif;base64,${b64}`, filename: name, saveAs: false, conflictAction: 'uniquify' });
    return `${info}\ndownloaded: ${fmtDl(await waitDownload(id, 60000))}`;
  }
  return { text: info, file: { data: b64, ext: 'gif' } };
};

// =====================================================================
async function run(tool, args) {
  const fn = T[tool];
  if (!fn) throw new Error(`unknown tool "${tool}"`);
  return fn(args);
}
