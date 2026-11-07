# Kendali — Browser MCP

Lets **any MCP client / any model** (Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, Cline, LM Studio, Goose…) control your real Chrome: the same idea as Claude in Chrome, but model-agnostic.

```
MCP client ──stdio──▶ mcp-server (Node) ──ws://127.0.0.1:18765──▶ Chrome extension (MV3)
```

## Install

1. **Extension**: open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked*, and pick the `extension/` folder.
2. **Server**: run `cd mcp-server && npm install`.
3. **Register it in your MCP client** (examples below). The client starts the server itself, and the extension connects automatically (badge shows **ON**).

### Claude Code
```bash
claude mcp add kendali -- node /Users/aswad/Development/aswad/chrome-ext/mcp-server/index.js
```

### Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.kendali]
command = "node"
args = ["/Users/aswad/Development/aswad/chrome-ext/mcp-server/index.js"]
```

### Gemini CLI / Cursor / VS Code / Cline / LM Studio (JSON)
```json
{ "mcpServers": { "kendali": { "command": "node", "args": ["/Users/aswad/Development/aswad/chrome-ext/mcp-server/index.js"] } } }
```

Several clients can run at the same time. The first one becomes the hub, and the others relay through it. If the hub exits, another client takes over.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context`, `tabs_create`, `tabs_close`, `tabs_switch` | Tab management |
| `navigate` | URL, `back`, `forward`, `reload` (waits for load) |
| `read_page` | Compact snapshot with `[ref]` numbers (viewport or `scope:"all"`, `diff:true`) |
| `find`, `get_page_text` | Search the page, read text (paginated) |
| `act` | click / hover / type / fill / select / check / press / scroll by ref, selector or text; `trusted:true` sends real input |
| `form_input` | Set a field by ref (text, select, checkbox) |
| `computer` | Screenshot / zoom / clicks / drag / type / key combos / scroll by coordinate or ref; `save_to` writes the image to a file |
| `wait_for` | Wait for text or a selector, or N seconds |
| `javascript_tool` | Run JS in the page (bypasses CSP, top-level await) |
| `read_console_messages`, `read_network_requests` | Console logs, network list, and response bodies (`request_id`) |
| `handle_dialog` | Accept or dismiss alert/confirm/prompt |
| `file_upload` | Put local files into `<input type=file>` |
| `download`, `downloads` | Download a URL with the browser's cookies; list/wait/cancel/pause/resume downloads |
| `save_pdf` | Print the page to PDF |
| `cookies`, `history` | Read and edit cookies, search history |
| `resize_window` | Resize the window |
| `browser_batch` | Run several tools in one call |

Text-only models can work with refs alone (`read_page` → `act`). Vision models can also use `computer` screenshots, where coordinates map 1:1 to clicks.

## Config
- `KENDALI_PORT` (default `18765`). If you change it, set the same port in the extension popup.
- `KENDALI_EXTENSION_ID`: accept only this extension id.
- `KENDALI_OUT_DIR`: default folder for PDFs and screenshots (`~/Downloads/kendali`).

## Security
- The server binds to `127.0.0.1` only. Connections from web pages are refused (Origin check).
- The agent drives your **logged-in** browser, and page content can contain prompt injection. Use it with models and tasks you trust.
- Tools that use the DevTools protocol show Chrome's "is debugging this browser" bar. This is expected.
