#!/usr/bin/env node
// Kendali MCP server: exposes browser-control tools to any MCP client and relays
// them over a localhost WebSocket to the Kendali Chrome extension.
//
// Several MCP clients can run at once: the first process to bind the port becomes the
// "hub" (the extension connects to it); later processes join the hub as peers.

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

// =====================================================================
// bridge
// =====================================================================
class Bridge {
  role = null; // 'hub' | 'peer'
  ext = null; // extension socket (hub)
  up = null; // socket to hub (peer)
  pending = new Map();
  extWaiters = [];
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
      if (this.ext && this.ext !== sock && this.ext.readyState === WebSocket.OPEN) {
        // another browser/profile already holds the connection: keep it, refuse the newcomer
        log('refused a second browser connection (one is already connected)');
        return sock.close(4001, 'another browser is already connected');
      }
      this.ext = sock;
      log('extension connected', origin);
      this.extWaiters.splice(0).forEach((f) => f());
      sock.on('message', (d) => this.onReply(d));
      sock.on('close', () => {
        if (this.ext !== sock) return;
        this.ext = null;
        log('extension disconnected');
        this.failAll('extension disconnected');
      });
    } else if (!origin) {
      // another local kendali-mcp process (browsers always send Origin, so web pages can't get here)
      sock.on('message', async (d) => {
        let m;
        try { m = JSON.parse(d); } catch { return; }
        try {
          const result = await this.call(m.tool, m.args, m.timeout);
          sock.send(JSON.stringify({ id: m.id, result }));
        } catch (e) {
          sock.send(JSON.stringify({ id: m.id, error: e.message }));
        }
      });
    } else {
      sock.close(1008, 'origin not allowed');
    }
  }

  join() {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
      s.once('open', () => { this.up = s; resolve(); });
      s.once('error', reject);
      s.on('message', (d) => this.onReply(d));
      s.on('close', () => {
        if (this.up !== s) return;
        this.up = null;
        this.role = null; // next call will try to become the hub
        this.failAll('hub connection lost');
      });
    });
  }

  onReply(d) {
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.type === 'ping') return this.ext?.send('{"type":"pong"}');
    if (m.type === 'hello') return log(`extension hello v${m.version} instance ${m.inst}`);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }

  failAll(msg) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
      this.pending.delete(id);
    }
  }

  waitExt(ms) {
    if (this.ext) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.extWaiters = this.extWaiters.filter((f) => f !== done);
        reject(new Error(`Chrome extension not connected. Make sure Chrome is open with the Kendali extension loaded (port ${PORT}).`));
      }, ms);
      const done = () => { clearTimeout(t); resolve(); };
      this.extWaiters.push(done);
    });
  }

  async call(tool, args = {}, timeout = 60000) {
    if (!this.role) await this.start();
    let sock;
    if (this.role === 'hub') {
      await this.waitExt(35000); // a sleeping service worker reconnects within ~30s
      sock = this.ext;
    } else {
      sock = this.up;
    }
    const id = `${process.pid}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${tool} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(JSON.stringify({ id, tool, args, timeout }));
    });
  }
}

const bridge = new Bridge();

// =====================================================================
// MCP tools
// =====================================================================
const server = new McpServer(
  { name: 'kendali', version: '0.1.0' },
  {
    instructions: `Kendali controls the user's real Chrome browser (their logged-in sessions).
Workflow: tabs_context → (tabs_create | navigate) → read_page to get [ref] numbers → act / form_input using refs → read_page (diff:true) or computer screenshot to verify.
Prefer ref-based tools (read_page/find/act/form_input) — cheap and work for text-only models. Use computer (screenshot + coordinates) for canvas, maps, drag, or when refs fail.
Refs go stale after navigation: run read_page again. If a JS alert/confirm blocks the page, call handle_dialog.
tabId is optional everywhere; it defaults to the focused tab.`,
  },
);

const tabId = z.number().int().optional().describe('Tab id from tabs_context. Defaults to the focused tab.');
const xy = z.array(z.number()).length(2);

async function saveFile(b64, ext, target) {
  let file = target;
  if (!file) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    file = path.join(OUT_DIR, `kendali-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
  } else {
    file = path.resolve(file.replace(/^~(?=$|\/)/, os.homedir()));
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  await fs.writeFile(file, Buffer.from(b64, 'base64'));
  return file;
}

function toContent(r) {
  const c = [];
  if (r?.text) c.push({ type: 'text', text: r.text });
  if (r?.image) c.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
  if (!c.length) c.push({ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r ?? 'ok') });
  return c;
}

const handlers = {};

function tool(name, description, shape, { after, timeout } = {}) {
  const handler = async (args) => {
    let r = await bridge.call(name, args, timeout ? timeout(args) : 45000);
    if (after) r = await after(r, args);
    return toContent(r);
  };
  handlers[name] = handler;
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return { content: await handler(args) };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
}

// ---- tabs & navigation ----
tool('tabs_context', 'List all open tabs (tabId, title, URL) grouped by window. Call this first to know which tabs exist.', {});

tool('tabs_create', 'Open a new tab, optionally at a URL, and wait for it to load. Returns the new tabId.', {
  url: z.string().optional().describe('URL to open (https:// added if no scheme)'),
  active: z.boolean().optional().describe('Focus the new tab (default true)'),
});

tool('tabs_close', 'Close one or more tabs.', {
  tabId: z.number().int().optional(),
  tabIds: z.array(z.number().int()).optional(),
});

tool('tabs_switch', 'Bring a tab to the front.', { tabId: z.number().int() });

tool('navigate', 'Go to a URL in a tab, or "back", "forward", "reload". Waits for the page to load.', {
  tabId,
  url: z.string().describe('URL, or "back" | "forward" | "reload"'),
  hard: z.boolean().optional().describe('With reload: bypass cache'),
  timeout: z.number().optional().describe('Load timeout ms (default 20000)'),
}, { timeout: (a) => (a.timeout || 20000) + 15000 });

// ---- reading ----
tool('read_page',
  'Compact accessibility snapshot of the page: headings and interactive elements, each with a [ref] number you can pass to act/form_input/computer/file_upload. ' +
  'By default only what is in the viewport; scope:"all" for the whole page. diff:true returns only what changed since the last snapshot.', {
    tabId,
    scope: z.enum(['view', 'all']).optional(),
    include_text: z.boolean().optional().describe('Also include plain text blocks (more tokens)'),
    diff: z.boolean().optional(),
    max_lines: z.number().int().optional().describe('Default 150'),
  });

tool('find', 'Search the whole page (including offscreen) for elements/text matching a query. Returns matching lines with [ref] numbers.', {
  tabId,
  query: z.string(),
});

tool('get_page_text', 'Read the visible text of the page (main/article by default) or of an element. Paginated with offset.', {
  tabId,
  selector: z.string().optional().describe('CSS selector of the element to read'),
  ref: z.number().int().optional(),
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
  'Interact with an element found via read_page/find. Target it with ref (preferred), selector, or text. ' +
  'Actions: click, hover, focus, scroll (into view; without target scrolls the page with dir up/down), type/fill (value; append, submit), clear, select (<select> option by value/text), check, uncheck, press (key, e.g. Enter). ' +
  'trusted:true sends real OS-level input via the DevTools protocol (use when synthetic events are ignored). Returns a snapshot diff afterwards.', {
    tabId,
    action: z.enum(['click', 'hover', 'focus', 'scroll', 'type', 'fill', 'clear', 'select', 'check', 'uncheck', 'press']),
    ref: z.number().int().optional(),
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
  });

tool('form_input', 'Set a form field value by ref: text inputs/textareas, <select> (option text or value), checkboxes/radios (true/false).', {
  tabId,
  ref: z.number().int().optional(),
  selector: z.string().optional(),
  value: z.union([z.string(), z.boolean(), z.number()]),
});

tool('computer',
  'Mouse/keyboard/screenshot control with real input events. Coordinates are CSS pixels of the viewport screenshot (they map 1:1). ' +
  'Actions: screenshot (full_page optional), zoom (region [x0,y0,x1,y1] at full resolution), left_click, right_click, middle_click, double_click, triple_click, hover, ' +
  'left_click_drag (start_coordinate → coordinate), type (text at focus), key (text: "Enter", "ctrl+a", "cmd+shift+t", space-separated sequence; repeat), ' +
  'scroll (scroll_direction, scroll_amount in ticks, at coordinate), scroll_to (ref), wait (duration s). Any click/hover/scroll can use ref instead of coordinate.', {
    tabId,
    action: z.enum(['screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover', 'mouse_move',
      'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'wait']),
    coordinate: xy.optional().describe('[x, y]'),
    start_coordinate: xy.optional(),
    ref: z.number().int().optional(),
    text: z.string().optional(),
    repeat: z.number().int().optional(),
    modifiers: z.string().optional().describe('For clicks, e.g. "ctrl", "shift+cmd"'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().optional(),
    region: z.array(z.number()).length(4).optional(),
    full_page: z.boolean().optional(),
    format: z.enum(['jpeg', 'png']).optional(),
    duration: z.number().optional(),
    save_to: z.string().optional().describe('screenshot/zoom: also save the image to this file path'),
    include_image: z.boolean().optional().describe('screenshot/zoom: return the image (default true; set false for text-only models with save_to)'),
  }, {
    timeout: (a) => (a.action === 'wait' ? (a.duration || 1) * 1000 + 15000 : 90000),
    after: async (r, a) => {
      if (r?.image && (a.save_to || a.include_image === false)) {
        const file = await saveFile(r.image.data, r.image.mimeType === 'image/png' ? 'png' : 'jpg', a.save_to);
        r.text += `\nsaved: ${file}`;
        if (a.include_image === false) delete r.image;
      }
      return r;
    },
  });

tool('file_upload', 'Attach local files to an <input type=file> (target by ref or selector — the input is often hidden; find it with find("file") or read_page scope:"all").', {
  tabId,
  ref: z.number().int().optional(),
  selector: z.string().optional(),
  paths: z.array(z.string()).describe('Absolute paths on this machine'),
});

tool('handle_dialog', 'Accept or dismiss a JavaScript alert/confirm/prompt/beforeunload dialog that is blocking the page.', {
  tabId,
  accept: z.boolean().optional().describe('Default true'),
  prompt_text: z.string().optional(),
});

// ---- dev tools ----
tool('javascript_tool', 'Run JavaScript in the page (main world, bypasses CSP). Top-level await allowed; the value of the last expression is returned (JSON-serialised).', {
  tabId,
  code: z.string(),
  timeout_ms: z.number().optional(),
  max_chars: z.number().int().optional(),
}, { timeout: (a) => (a.timeout_ms || 30000) + 15000 });

tool('read_console_messages', 'Read console logs/errors/exceptions of a tab (tracking starts on first call or first DevTools-based tool).', {
  tabId,
  pattern: z.string().optional().describe('Regex filter'),
  only_errors: z.boolean().optional(),
  limit: z.number().int().optional(),
  clear: z.boolean().optional(),
});

tool('read_network_requests', 'List network requests of a tab (method, status, type, URL), or pass request_id to read that response body (great for grabbing API JSON).', {
  tabId,
  url_pattern: z.string().optional().describe('Regex filter on URL'),
  types: z.array(z.string()).optional().describe('e.g. ["XHR","Fetch","Document"]'),
  only_failed: z.boolean().optional(),
  request_id: z.string().optional(),
  limit: z.number().int().optional(),
  max_chars: z.number().int().optional(),
  clear: z.boolean().optional(),
});

// ---- window, files, data ----
tool('resize_window', 'Resize the browser window of a tab (useful to test responsive layouts).', {
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

// ---- batch ----
server.registerTool('browser_batch', {
  description: 'Run several Kendali tool calls in order in one round-trip, e.g. [{tool:"act",args:{action:"fill",ref:3,value:"x"}},{tool:"act",args:{action:"click",ref:5}}]. Stops at the first error unless continue_on_error.',
  inputSchema: {
    actions: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })),
    continue_on_error: z.boolean().optional(),
  },
}, async ({ actions, continue_on_error }) => {
  const content = [];
  let failed = false;
  for (const [i, { tool: name, args }] of actions.entries()) {
    const h = handlers[name];
    try {
      if (!h) throw new Error(`unknown tool "${name}"`);
      const c = await h(args || {});
      content.push({ type: 'text', text: `#${i + 1} ${name}:` }, ...c);
    } catch (e) {
      failed = true;
      content.push({ type: 'text', text: `#${i + 1} ${name} ERROR: ${e.message}` });
      if (!continue_on_error) break;
    }
  }
  return { content, isError: failed && !continue_on_error };
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
