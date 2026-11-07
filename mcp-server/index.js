#!/usr/bin/env node
// Kendali MCP server: exposes browser-control tools to any MCP client and relays
// them over a localhost WebSocket to the Kendali Chrome extension.
//
// Tool names and parameters mirror Claude in Chrome (tabs_context_mcp, read_page, computer, …),
// plus Kendali extras (act, wait_for, download, save_pdf, cookies, …).
//
// Several MCP clients can run at once: the first process to bind the port becomes the
// "hub" (every browser's extension connects to it); later processes join the hub as peers.
// Several browsers/profiles can be connected; each MCP session picks one (select_browser).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

const PORT = +process.env.KENDALI_PORT || 18765;
const EXT_ID = process.env.KENDALI_EXTENSION_ID || ''; // optional: only accept this extension id
const OUT_DIR = process.env.KENDALI_OUT_DIR || path.join(os.homedir(), 'Downloads', 'kendali');
const log = (...a) => console.error('[kendali]', ...a); // stdout belongs to MCP
const NOT_CONNECTED = `Chrome extension not connected. Make sure Chrome is open with the Kendali extension loaded (port ${PORT}).`;

// =====================================================================
// bridge
// =====================================================================
class Bridge {
  role = null; // 'hub' | 'peer'
  up = null; // socket to hub (peer)
  exts = new Map(); // extension socket -> { sock, deviceId, name, platform, version }
  pending = new Map();
  waiters = [];
  pairs = new Map();
  seq = 0;
  starting = null;

  start() {
    this.starting ??= (async () => {
      try {
        await this.listen();
        this.role = 'hub';
        log(`hub listening on 127.0.0.1:${PORT}`);
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        await this.join();
        this.role = 'peer';
        log(`joined existing hub on port ${PORT}`);
      }
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
      wss.once('listening', () => {
        wss.on('error', (e) => log('server error', e.message));
        this.wss = wss;
        resolve();
      });
      wss.once('error', reject);
      wss.on('connection', (sock, req) => this.onConnection(sock, req));
    });
  }

  onConnection(sock, req) {
    const origin = req.headers.origin || '';
    if (origin.startsWith('chrome-extension://')) {
      if (EXT_ID && origin !== `chrome-extension://${EXT_ID}`) return sock.close(1008, 'extension id not allowed');
      const info = { sock, deviceId: null, name: '(connecting)', platform: '', version: '' };
      this.exts.set(sock, info);
      sock.on('message', (d) => this.onExtMessage(info, d));
      sock.on('close', () => {
        if (this.exts.get(sock) !== info) return;
        this.exts.delete(sock);
        log(`browser disconnected: ${info.name}`);
        this.failWhere((p) => p.sock === sock, `browser "${info.name}" disconnected`);
      });
    } else if (!origin) {
      // another local kendali-mcp process (browsers always send Origin, so web pages can't get here)
      sock.on('message', async (d) => {
        let m;
        try { m = JSON.parse(d); } catch { return; }
        try {
          const result = await this.call(m.tool, m.args, m.timeout, m.device);
          sock.send(JSON.stringify({ id: m.id, result }));
        } catch (e) {
          sock.send(JSON.stringify({ id: m.id, error: e.message }));
        }
      });
    } else {
      sock.close(1008, 'origin not allowed');
    }
  }

  onExtMessage(info, d) {
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.type === 'ping') return info.sock.send('{"type":"pong"}');
    if (m.type === 'hello') {
      const deviceId = m.deviceId || `legacy-${m.inst}`;
      // a restarted service worker of the same browser replaces its old socket
      for (const [s, o] of this.exts) {
        if (o !== info && o.deviceId === deviceId) { this.exts.delete(s); s.close(4002, 'replaced by a newer connection'); }
      }
      Object.assign(info, { deviceId, name: m.name || 'Chrome', platform: m.platform || '', version: m.version || '' });
      log(`browser connected: ${info.name} [${deviceId}] v${info.version}`);
      return this.notify();
    }
    if (m.type === 'pair_accept') {
      const p = this.pairs.get(m.id);
      if (!p) return;
      if (m.name) info.name = m.name;
      this.pairs.delete(m.id);
      clearTimeout(p.timer);
      this.broadcast({ type: 'pair_done', id: m.id });
      return p.resolve({ deviceId: info.deviceId, name: info.name });
    }
    this.onReply(m);
  }

  join() {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
      s.once('open', () => { this.up = s; resolve(); });
      s.once('error', reject);
      s.on('message', (d) => { try { this.onReply(JSON.parse(d)); } catch { /* ignore */ } });
      s.on('close', () => {
        if (this.up !== s) return;
        this.up = null;
        this.role = null; // next call will try to become the hub
        this.failWhere(() => true, 'hub connection lost');
      });
    });
  }

  onReply(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }

  failWhere(pred, msg) {
    for (const [id, p] of this.pending) {
      if (!pred(p)) continue;
      clearTimeout(p.timer);
      p.reject(new Error(msg));
      this.pending.delete(id);
    }
  }

  ready() {
    return [...this.exts.values()].filter((i) => i.deviceId && i.sock.readyState === WebSocket.OPEN);
  }

  broadcast(msg) {
    for (const i of this.ready()) i.sock.send(JSON.stringify(msg));
  }

  notify() {
    this.waiters = this.waiters.filter((w) => !w());
  }

  waitFor(pred, ms, msg) {
    const v = pred();
    if (v) return Promise.resolve(v);
    return new Promise((resolve, reject) => {
      const w = () => {
        const x = pred();
        if (!x) return false;
        clearTimeout(t);
        resolve(x);
        return true;
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((f) => f !== w);
        reject(new Error(msg));
      }, ms);
      this.waiters.push(w);
    });
  }

  // which browser gets this call (a sleeping service worker reconnects within ~30s)
  async pick(device) {
    if (device) {
      return this.waitFor(() => this.ready().find((i) => i.deviceId === device), 35000,
        `the selected browser (${device}) is not connected — call list_connected_browsers`);
    }
    await this.waitFor(() => this.ready()[0], 35000, NOT_CONNECTED);
    const all = this.ready();
    if (all.length > 1) {
      throw new Error(`${all.length} browsers are connected (${all.map((i) => `${i.name} [${i.deviceId}]`).join(', ')}) and none is selected for this session. ` +
        'Call list_connected_browsers, ask the user which one to use, then select_browser {deviceId} (or switch_browser).');
    }
    return all[0];
  }

  list(device) {
    const all = this.ready();
    return all.map((i) => ({
      deviceId: i.deviceId, name: i.name, platform: i.platform, version: i.version,
      isLocal: true, onThisComputer: true, // the hub only listens on 127.0.0.1
      inUse: device ? i.deviceId === device : all.length === 1,
    }));
  }

  async pair(timeout) {
    await this.waitFor(() => this.ready()[0], 35000, NOT_CONNECTED);
    const id = crypto.randomUUID();
    this.broadcast({ type: 'pair', id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairs.delete(id);
        this.broadcast({ type: 'pair_done', id });
        reject(new Error(`no browser was connected within ${Math.round(timeout / 1000)}s (the user did not click Connect)`));
      }, timeout);
      this.pairs.set(id, { resolve, timer });
    });
  }

  send(sock, msg, timeout) {
    const id = `${process.pid}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${msg.tool} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, sock });
      sock.send(JSON.stringify({ id, ...msg }));
    });
  }

  async call(tool, args = {}, timeout = 60000, device = null) {
    if (!this.role) await this.start();
    if (this.role === 'peer') return this.send(this.up, { tool, args, timeout, device }, timeout + 5000);
    if (tool === '__list') return this.list(device);
    if (tool === '__pair') return this.pair(timeout);
    const ext = await this.pick(device);
    return this.send(ext.sock, { tool, args, timeout }, timeout);
  }
}

const bridge = new Bridge();
let selectedDevice = null; // browser chosen for this MCP session (select_browser / switch_browser)
const call = (tool, args, timeout) => bridge.call(tool, args, timeout, selectedDevice);

// =====================================================================
// helpers: files, screenshot ids, GIF recording
// =====================================================================
async function saveFile(b64, ext, target) {
  let file = target;
  if (!file) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    file = path.join(OUT_DIR, `kendali-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
  } else {
    file = path.resolve(OUT_DIR, file.replace(/^~(?=$|\/)/, os.homedir()));
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  await fs.writeFile(file, Buffer.from(b64, 'base64'));
  return file;
}

// screenshots get an imageId so upload_image can reuse them (kept 10 minutes)
const shots = new Map();
function cacheShot(img) {
  const now = Date.now();
  for (const [k, v] of shots) if (now - v.t > 600000 || shots.size > 40) shots.delete(k);
  const id = `ss_${crypto.randomBytes(4).toString('hex')}`;
  shots.set(id, { ...img, t: now });
  return id;
}

const rec = { on: false, frames: [] };
const RECORDED = new Set(['navigate', 'act', 'form_input', 'computer', 'tabs_create_mcp', 'tabs_switch', 'file_upload', 'upload_image']);
const short = (s, n = 40) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function labelFor(name, a) {
  if (a.action_summary) return a.action_summary;
  switch (name) {
    case 'navigate': return ['back', 'forward', 'reload'].includes(String(a.url).toLowerCase()) ? `Go ${a.url}` : `Navigate to ${short(a.url, 60)}`;
    case 'tabs_create_mcp': return a.url ? `Open ${short(a.url, 60)}` : 'Open new tab';
    case 'computer':
      if (a.action === 'type') return `Type "${short(a.text)}"`;
      if (a.action === 'key') return `Press ${short(a.text)}`;
      return a.action.replace(/_/g, ' ');
    case 'act': return `${a.action}${a.value != null ? ` "${short(a.value)}"` : ''}${a.key ? ` ${a.key}` : ''}`;
    case 'form_input': return `Set field to "${short(a.value)}"`;
    default: return name.replace(/_/g, ' ');
  }
}

async function recordFrame(name, a, r) {
  if (!rec.on || !RECORDED.has(name) || rec.frames.length >= 300) return;
  if (name === 'computer' && (a.action === 'zoom' || a.full_page || a.action === 'wait')) return;
  let img = r?.full || r?.image;
  if (!img) {
    const s = await call('computer', { tabId: a.tabId, action: 'screenshot', format: 'jpeg' }, 60000).catch(() => null);
    img = s?.full || s?.image;
    if (!img) return;
  }
  const at = /at \((\d+),(\d+)\)/.exec(r?.text || '');
  rec.frames.push({
    data: img.data, mime: img.mimeType,
    label: name === 'computer' && a.action === 'screenshot' ? '' : labelFor(name, a),
    click: /click/.test(a.action || '') && at ? [+at[1], +at[2]] : null,
    drag: a.action === 'left_click_drag' && a.start_coordinate && a.coordinate ? [a.start_coordinate, a.coordinate] : null,
  });
}

function toContent(r) {
  const c = [];
  if (r?.text) c.push({ type: 'text', text: r.text });
  if (r?.image) c.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
  if (!c.length) c.push({ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r ?? 'ok') });
  return c;
}

// =====================================================================
// MCP tools
// =====================================================================
const server = new McpServer(
  { name: 'kendali', version: '0.2.0' },
  {
    instructions: `Kendali controls the user's real Chrome browser (their logged-in sessions). Tool names and parameters follow Claude in Chrome.
Workflow: tabs_context_mcp → tabs_create_mcp (or navigate without tabId, which uses Kendali's own tab group) → read_page / find to get refs (ref_1, ref_2…) → form_input / computer {ref} / act → verify with read_page or a computer screenshot.
Ref-based tools are cheap and work for text-only models; screenshots + coordinates work for vision models (coordinates map 1:1 to clicks).
Refs go stale after navigation: run read_page again. If a JS alert/confirm blocks the page, call handle_dialog.
tabId is optional in most tools; it defaults to the tab Kendali used last.
If several browsers are connected, call list_connected_browsers, ask the user, then select_browser.`,
  },
);

const tabId = z.number().int().optional().describe('Tab id from tabs_context_mcp. Defaults to the tab Kendali used last (else the focused tab).');
const ref = z.union([z.string(), z.number()]).describe('Element reference from read_page/find, e.g. "ref_12"');
const xy = z.array(z.number()).length(2);
const summary = z.string().optional().describe('A few words on what this action does (shown in GIF recordings)');

const handlers = {};

function register(name, description, shape, handler) {
  handlers[name] = handler;
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const r = await handler(args);
      return Array.isArray(r) ? { content: r } : r;
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
}

// a tool executed by the extension
function tool(name, description, shape, { after, timeout } = {}) {
  register(name, description, shape, async (args) => {
    let r = await call(name, args, timeout ? timeout(args) : 45000);
    await recordFrame(name, args, r).catch((e) => log('gif frame failed:', e.message));
    if (after) r = await after(r, args);
    return toContent(r);
  });
}
const text = (t) => [{ type: 'text', text: t }];

// ---- tabs & navigation ----
tool('tabs_context_mcp',
  "List tabs: first those in Kendali's own tab group (yours to use), then the user's other tabs. Call this first. " +
  'createIfEmpty:true creates a new window with a Kendali tab group if none exists. Each new task should use its own tab (tabs_create_mcp) unless the user points at an existing one.', {
    createIfEmpty: z.boolean().optional(),
  });

tool('tabs_create_mcp', "Create a new tab in Kendali's tab group (optionally at a URL, waiting for it to load). Returns the new tabId. Close it with tabs_close_mcp when done unless the user wants it kept.", {
  url: z.string().optional().describe('URL to open (https:// added if no scheme)'),
  active: z.boolean().optional().describe('Focus the new tab (default true)'),
});

tool('tabs_close_mcp', 'Close one or more tabs by id.', {
  tabId: z.number().int().optional(),
  tabIds: z.array(z.number().int()).optional(),
});

tool('tabs_switch', 'Bring a tab to the front and focus its window.', { tabId: z.number().int() });

tool('navigate',
  'Navigate to a URL, or "back" / "forward" / "reload" (waits for the page to load). ' +
  "Without tabId, a URL opens in Kendali's own tab group (created if needed) and the tab list is appended to the result.", {
    tabId,
    url: z.string().describe('URL (https:// added if no scheme), or "back" | "forward" | "reload"'),
    hard: z.boolean().optional().describe('With reload: bypass cache'),
    timeout: z.number().optional().describe('Load timeout ms (default 20000)'),
  }, { timeout: (a) => (a.timeout || 20000) + 15000 });

// ---- reading ----
tool('read_page',
  'Accessibility-style snapshot of the page: headings and interactive elements, each with a ref (e.g. [ref_12]) you can pass to form_input/computer/act/file_upload. ' +
  'Default: only what is in the viewport (cheap). filter:"interactive" = whole page, controls only; filter:"all" = whole page including text. ' +
  'ref_id = read only inside that element; depth limits nesting; max_chars caps the output (default 50000). diff:true returns only what changed since the last snapshot.', {
    tabId,
    filter: z.enum(['interactive', 'all']).optional(),
    ref_id: ref.optional(),
    depth: z.number().int().optional(),
    max_chars: z.number().int().optional(),
    scope: z.enum(['view', 'all']).optional().describe('Kendali: viewport (default) or whole page'),
    include_text: z.boolean().optional().describe('Also include plain text blocks'),
    diff: z.boolean().optional(),
    max_lines: z.number().int().optional().describe('Default 150 (viewport mode)'),
  });

tool('find',
  'Find elements by purpose or text, e.g. "search bar", "login button", "price of the blue shirt". Searches the whole page (including offscreen) and returns up to 20 matching elements with refs. ' +
  'If there are more than 20 matches you are told to be more specific.', {
    tabId,
    query: z.string(),
  });

tool('get_page_text', 'Extract plain text of the page, prioritising the main/article content (or a given element). Paginated with offset.', {
  tabId,
  selector: z.string().optional().describe('CSS selector of the element to read'),
  ref: ref.optional(),
  offset: z.number().int().optional(),
  max_chars: z.number().int().optional().describe('Default 4000'),
});

tool('wait_for', 'Wait until text or a CSS selector appears (or disappears with gone:true), or just wait N seconds.', {
  tabId,
  text: z.string().optional(),
  selector: z.string().optional(),
  gone: z.boolean().optional(),
  seconds: z.number().optional(),
  timeout: z.number().optional().describe('ms, default 10000'),
}, { timeout: (a) => Math.max(a.timeout || 10000, (a.seconds || 0) * 1000) + 15000 });

// ---- interacting ----
tool('act',
  'Kendali: interact with an element by ref (preferred), selector, or visible text. ' +
  'Actions: click, hover, focus, scroll (into view; without target scrolls the page with dir up/down), type/fill (value; append, submit), clear, select (<select> option by value/text), check, uncheck, press (key, e.g. Enter). ' +
  'trusted:true sends real input via the DevTools protocol (use when synthetic events are ignored). Returns a snapshot diff afterwards.', {
    tabId,
    action: z.enum(['click', 'hover', 'focus', 'scroll', 'type', 'fill', 'clear', 'select', 'check', 'uncheck', 'press']),
    ref: ref.optional(),
    selector: z.string().optional(),
    text: z.string().optional().describe('Locate by visible text/label'),
    value: z.string().optional(),
    key: z.string().optional().describe('For press'),
    dir: z.enum(['up', 'down']).optional(),
    amount: z.number().optional().describe('Scroll pixels'),
    append: z.boolean().optional(),
    submit: z.boolean().optional().describe('Press Enter after typing'),
    trusted: z.boolean().optional(),
    snapshot: z.boolean().optional().describe('Return snapshot diff after acting (default true)'),
    action_summary: summary,
  });

tool('form_input', 'Set a form element value by ref: text inputs/textareas (string/number), <select> (option value or text), checkboxes/radios (boolean).', {
  tabId,
  ref: ref.optional(),
  selector: z.string().optional(),
  value: z.union([z.string(), z.boolean(), z.number()]),
  action_summary: summary,
});

tool('computer',
  'Mouse/keyboard/screenshot control with real input events. Coordinates are CSS pixels of the viewport screenshot (they map 1:1 to clicks). ' +
  'Actions: screenshot (full_page optional), zoom (region [x0,y0,x1,y1]), left_click, right_click, middle_click, double_click, triple_click, hover, ' +
  'left_click_drag (start_coordinate → coordinate), type (text at focus), key (text: "Enter", "cmd+a", "Backspace Backspace", space-separated; repeat), ' +
  'scroll (scroll_direction, scroll_amount ticks, at coordinate), scroll_to (ref), wait (duration s). Clicks/hover/scroll can use ref instead of coordinate. ' +
  'Screenshots return an imageId usable with upload_image; scale<1 returns a smaller image (coordinates stay in the full frame).', {
    tabId,
    action: z.enum(['screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover', 'mouse_move',
      'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'wait']),
    coordinate: xy.optional().describe('[x, y]'),
    start_coordinate: xy.optional(),
    ref: ref.optional(),
    text: z.string().optional(),
    repeat: z.number().int().min(1).max(100).optional(),
    modifiers: z.string().optional().describe('For clicks: "ctrl", "shift", "alt", "cmd"/"meta", combined with "+"'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().optional(),
    region: z.array(z.number()).length(4).optional(),
    duration: z.number().optional(),
    scale: z.number().min(0.1).max(1).optional(),
    save_to_disk: z.boolean().optional().describe(`screenshot/zoom: save the image under ${OUT_DIR} and return the path`),
    action_summary: summary,
    full_page: z.boolean().optional(),
    format: z.enum(['jpeg', 'png']).optional(),
    save_to: z.string().optional().describe('screenshot/zoom: save the image to this file path'),
    include_image: z.boolean().optional().describe('screenshot/zoom: return the image (default true; false for text-only models with save_to)'),
  }, {
    timeout: (a) => (a.action === 'wait' ? (a.duration || 1) * 1000 + 15000 : 90000),
    after: async (r, a) => {
      const img = r?.full || r?.image;
      if (img) {
        r.text += `\nimageId: ${cacheShot(img)}`;
        if (a.save_to || a.save_to_disk) r.text += `\nsaved: ${await saveFile(img.data, img.mimeType === 'image/png' ? 'png' : 'jpg', a.save_to)}`;
        if (a.include_image === false) delete r.image;
      }
      delete r?.full;
      return r;
    },
  });

tool('file_upload',
  'Upload local files to an <input type=file> by ref (or selector). Do not click file inputs (that opens a native picker you cannot use) — find the input with find/read_page and use its ref.', {
    tabId,
    ref: ref.optional(),
    selector: z.string().optional(),
    paths: z.array(z.string()).describe('Absolute paths on this machine'),
  });

register('upload_image',
  'Upload a screenshot taken with computer (its imageId) to a file input or drag-and-drop target. Either ref (file input or drop zone) or coordinate (drop location, e.g. into a document editor). ' +
  'Screenshot ids expire after 10 minutes.', {
    imageId: z.string(),
    tabId,
    ref: ref.optional(),
    coordinate: xy.optional(),
    filename: z.string().optional().describe('Default "image.png"'),
  }, async (a) => {
    const img = shots.get(a.imageId);
    if (!img) throw new Error(`unknown or expired imageId "${a.imageId}" — take a new screenshot`);
    const r = await call('upload_image', { tabId: a.tabId, ref: a.ref, coordinate: a.coordinate, filename: a.filename, data: img.data, mime: img.mimeType }, 60000);
    await recordFrame('upload_image', a, r).catch(() => {});
    return toContent(r);
  });

tool('handle_dialog', 'Accept or dismiss a JavaScript alert/confirm/prompt/beforeunload dialog that is blocking the page.', {
  tabId,
  accept: z.boolean().optional().describe('Default true'),
  prompt_text: z.string().optional(),
});

// ---- dev tools ----
tool('javascript_tool',
  'Execute JavaScript in the page (main world, bypasses CSP) with REPL semantics: top-level await works and the value of the last expression is returned (JSON). ' +
  'Pass the code in `text` (with action:"javascript_exec") or in `code`.', {
    tabId,
    action: z.string().optional().describe('"javascript_exec"'),
    text: z.string().optional().describe('JavaScript code'),
    code: z.string().optional().describe('Alias of text'),
    timeout_ms: z.number().optional(),
    max_chars: z.number().int().optional(),
  }, { timeout: (a) => (a.timeout_ms || 30000) + 15000 });

tool('read_console_messages', 'Read console logs/errors/exceptions of a tab (tracking starts on the first call or first DevTools-based tool). Use pattern to filter.', {
  tabId,
  pattern: z.string().optional().describe('Regex filter'),
  onlyErrors: z.boolean().optional(),
  only_errors: z.boolean().optional().describe('Alias of onlyErrors'),
  limit: z.number().int().optional(),
  clear: z.boolean().optional(),
});

tool('read_network_requests', 'List network requests of a tab (id, method, status, type, URL), or pass request_id to read that response body (great for grabbing API JSON).', {
  tabId,
  urlPattern: z.string().optional().describe('Only URLs containing this string'),
  url_pattern: z.string().optional().describe('Regex filter on URL'),
  types: z.array(z.string()).optional().describe('e.g. ["XHR","Fetch","Document"]'),
  only_failed: z.boolean().optional(),
  request_id: z.string().optional(),
  limit: z.number().int().optional(),
  max_chars: z.number().int().optional(),
  clear: z.boolean().optional(),
});

// ---- window, files, data ----
tool('resize_window', 'Resize the browser window of a tab (e.g. to test responsive layouts).', {
  tabId,
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

tool('save_pdf', 'Print the current page to a PDF file on disk.', {
  tabId,
  path: z.string().optional().describe(`File path (default ${OUT_DIR}/kendali-<time>.pdf)`),
  landscape: z.boolean().optional(),
  print_background: z.boolean().optional(),
}, {
  timeout: () => 150000,
  after: async (r, a) => ({ text: `${r.text}\nsaved: ${await saveFile(r.file.data, 'pdf', a.path)}` }),
});

tool('download', "Download a URL with Chrome's download manager (uses the browser's cookies/login). Waits until finished and returns the local file path.", {
  url: z.string(),
  filename: z.string().optional().describe('Path relative to the Chrome Downloads folder, e.g. "reports/q3.pdf"'),
  headers: z.record(z.string(), z.string()).optional(),
  wait: z.boolean().optional().describe('Default true'),
  timeout: z.number().optional().describe('ms, default 120000'),
}, { timeout: (a) => (a.timeout || 120000) + 15000 });

tool('downloads',
  'Manage downloads. action: list (recent, optional query), wait (wait for a download started in the last since_seconds — call right after clicking a download button — and return its file path), cancel/pause/resume/erase/show (id).', {
    action: z.enum(['list', 'wait', 'cancel', 'pause', 'resume', 'erase', 'show']).optional(),
    id: z.number().int().optional(),
    query: z.string().optional(),
    limit: z.number().int().optional(),
    since_seconds: z.number().optional().describe('wait: default 30'),
    timeout: z.number().optional().describe('wait: ms, default 120000'),
  }, { timeout: (a) => (a.timeout || 120000) + 15000 });

tool('cookies', 'Read or change cookies. action: list (for url/domain, default current tab), set, remove.', {
  tabId,
  action: z.enum(['list', 'set', 'remove']).optional(),
  url: z.string().optional(),
  domain: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  http_only: z.boolean().optional(),
  expires_days: z.number().optional(),
});

tool('history', 'Search browsing history.', {
  query: z.string().optional(),
  days: z.number().optional().describe('Default 7'),
  limit: z.number().int().optional(),
});

// ---- GIF recording ----
register('gif_creator',
  'Record browser actions and export them as an animated GIF with overlays (click indicators, drag paths, action labels, progress bar, watermark). ' +
  "Actions: start_recording (then take a screenshot to capture the first frame), stop_recording (take a screenshot just before, to capture the last frame), export, clear. " +
  'While recording, every navigate/click/type/form action adds a frame. export: download:true saves the GIF through Chrome downloads; coordinate drops it onto the page instead.', {
    action: z.enum(['start_recording', 'stop_recording', 'export', 'clear']),
    tabId,
    download: z.boolean().optional(),
    filename: z.string().optional().describe("Default 'recording-<timestamp>.gif'"),
    coordinate: xy.optional().describe('export: drag-and-drop the GIF onto this point of the page'),
    options: z.object({
      showClickIndicators: z.boolean().optional(),
      showDragPaths: z.boolean().optional(),
      showActionLabels: z.boolean().optional(),
      showProgressBar: z.boolean().optional(),
      showWatermark: z.boolean().optional(),
      quality: z.number().min(1).max(30).optional().describe('1-30, lower = better quality (default 10)'),
    }).optional(),
  }, async (a) => {
    switch (a.action) {
      case 'start_recording':
        rec.on = true;
        return text(`recording started (${rec.frames.length} frame(s) already buffered). Take a screenshot now to capture the first frame.`);
      case 'stop_recording':
        rec.on = false;
        return text(`recording stopped: ${rec.frames.length} frame(s) kept. Use export (or clear).`);
      case 'clear':
        rec.frames = [];
        return text('frames cleared');
      case 'export': {
        if (!rec.frames.length) throw new Error('no frames recorded — start_recording, act, take screenshots, then export');
        const filename = a.filename || `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.gif`;
        const r = await call('gif_render', {
          frames: rec.frames, options: a.options || {}, filename,
          download: !a.coordinate && a.download !== false,
          drop: a.coordinate ? { tabId: a.tabId, coordinate: a.coordinate } : null,
        }, 300000);
        if (r?.file) return text(`${r.text}\nsaved: ${await saveFile(r.file.data, 'gif', filename)}`);
        return toContent(r);
      }
    }
    throw new Error(`unknown action ${a.action}`);
  });

// ---- several browsers ----
register('list_connected_browsers',
  'List the Chrome browsers/profiles with the Kendali extension connected: deviceId, name, platform, isLocal, onThisComputer, inUse. ' +
  'Not needed when only one browser is connected. If several are connected and none is selected, ask the user (AskUserQuestion-style: one option per browser, plus ' +
  '"Open a confirmation screen in every connected browser and let me select the right one there"), then call select_browser or switch_browser.', {},
async () => {
  const list = await bridge.call('__list', {}, 10000, selectedDevice);
  if (!list.length) return text(`no browsers connected. ${NOT_CONNECTED}`);
  return text(JSON.stringify(list, null, 1));
});

register('select_browser', 'Use the browser with this deviceId (from list_connected_browsers) for the rest of this session.', {
  deviceId: z.string(),
}, async (a) => {
  const list = await bridge.call('__list', {}, 10000, null);
  const b = list.find((x) => x.deviceId === a.deviceId);
  if (!b) throw new Error(`no connected browser with deviceId ${a.deviceId}; connected: ${list.map((x) => `${x.name} [${x.deviceId}]`).join(', ') || 'none'}`);
  selectedDevice = b.deviceId;
  return text(`using ${b.name} [${b.deviceId}] for this session`);
});

register('switch_browser',
  'Show a confirmation window in every connected browser and wait (up to 2 minutes) for the user to click Connect in the one they want; that browser is then used for this session.', {},
async () => {
  const r = await bridge.call('__pair', {}, 120000, null);
  selectedDevice = r.deviceId;
  return text(`using ${r.name} [${r.deviceId}] for this session`);
});

// ---- batch ----
const ALIASES = { tabs_context: 'tabs_context_mcp', tabs_create: 'tabs_create_mcp', tabs_close: 'tabs_close_mcp' };
register('browser_batch',
  'Execute several tool calls in ONE round trip, sequentially, stopping at the first error (unless continue_on_error). ' +
  'Each item is {name, input} with input exactly as for the tool on its own (also accepted: {tool, args}). Use it whenever you can predict two or more steps ahead. ' +
  'Screenshots are returned interleaved; coordinates in this batch refer to the screenshot taken before the call. Cannot be nested.', {
    actions: z.array(z.object({
      name: z.string().optional(),
      input: z.record(z.string(), z.any()).optional(),
      tool: z.string().optional(),
      args: z.record(z.string(), z.any()).optional(),
    })).min(1),
    continue_on_error: z.boolean().optional(),
  }, async ({ actions, continue_on_error }) => {
    const content = [];
    for (const [i, it] of actions.entries()) {
      let name = String(it.name || it.tool || '').replace(/^mcp__.+?__/, '');
      name = ALIASES[name] || name;
      const h = handlers[name];
      try {
        if (!h || name === 'browser_batch') throw new Error(`unknown tool "${name}"`);
        const r = await h(it.input || it.args || {});
        const c = Array.isArray(r) ? r : r.content;
        content.push({ type: 'text', text: `#${i + 1} ${name}:` }, ...c);
        if (r.isError) throw new Error('failed');
      } catch (e) {
        if (e.message !== 'failed') content.push({ type: 'text', text: `#${i + 1} ${name} ERROR: ${e.message}` });
        if (!continue_on_error) {
          content.push({ type: 'text', text: `(stopped at #${i + 1}; ${actions.length - i - 1} action(s) not run)` });
          return { content, isError: true };
        }
      }
    }
    return content;
  });

// =====================================================================
await bridge.start().catch((e) => log('bridge start failed (will retry on first call):', e.message));
await server.connect(new StdioServerTransport());
log('MCP server ready');

// exit when the MCP client goes away (otherwise the WebSocket hub keeps the process alive)
const bye = () => process.exit(0);
process.stdin.on('end', bye);
process.stdin.on('close', bye);
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
