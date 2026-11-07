# Kendali — Browser MCP

Lets **any MCP client / any model** (Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, Cline, LM Studio, Goose…) control your real Chrome: the same idea as Claude in Chrome, but model-agnostic.

```
MCP client ──stdio──▶ mcp-server (Node) ──ws://127.0.0.1:18765──▶ Chrome extension (MV3)
```

## Install

1. **Extension**: install **Kendali – Browser MCP** from the Chrome Web Store. To use the source instead: open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked*, and pick the `extension/` folder.
2. **Register the MCP server in your AI client.** It is published on npm as [`kendali-mcp`](https://www.npmjs.com/package/kendali-mcp), so the client runs it with `npx` and you install nothing yourself (Node 18+). The extension connects automatically (badge shows **ON**).

### Claude Code
```bash
claude mcp add kendali -- npx -y kendali-mcp
```

### Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.kendali]
command = "npx"
args = ["-y", "kendali-mcp"]
```

### OpenCode (`~/.config/opencode/opencode.json`)
```json
{ "mcp": { "kendali": { "type": "local", "command": ["npx", "-y", "kendali-mcp"], "enabled": true } } }
```

### Gemini CLI / Cursor / VS Code / Cline / LM Studio (JSON)
```json
{ "mcpServers": { "kendali": { "command": "npx", "args": ["-y", "kendali-mcp"] } } }
```

### Agent skill (optional)
`skills/kendali-browser/SKILL.md` teaches a model the workflow. Copy it into your client's skills folder (for example `~/.claude/skills/kendali-browser/`).

Several clients can run at the same time. The first one becomes the hub, and the others relay through it. If the hub exits, another client takes over.

## Tools

Tool names and parameters match **Claude in Chrome** (`mcp__claude-in-chrome__*`): the same calls work here, and Kendali adds a few extra tools.

| Tool | What it does |
|---|---|
| `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `tabs_switch` | Agent tabs live in a green **Kendali** tab group, and the user's own tabs are listed separately. `createIfEmpty:true` opens a window when the group is empty |
| `navigate` | URL, `back`, `forward`, `reload` (waits for load). With no `tabId` it uses the group tab |
| `read_page` | Snapshot with `[ref_N]` refs. Options: `filter:"interactive"\|"all"`, `ref_id` (subtree), `depth`, `max_chars`, plus `scope:"all"` and `diff:true` |
| `find` | Natural-language search (`"search bar"`, `"login button"`). Returns at most 20 refs |
| `get_page_text` | Read the article or page text (paginated) |
| `computer` | `screenshot` (`scale`), `zoom`, left/right/double/triple click, drag, `type`, `key`, `scroll`, `scroll_to`, `hover`, `wait`, by `coordinate` or `ref`. Screenshots return an `imageId` |
| `form_input` | Set a field by ref (text, select, checkbox) |
| `act`, `wait_for` | Extras: high-level click/type/select by ref, selector or text with a diff result; wait for text or a selector |
| `javascript_tool` | `{action:"javascript_exec", text}` (also `code`). Bypasses CSP, supports top-level await |
| `read_console_messages`, `read_network_requests` | `onlyErrors`, `pattern`, `urlPattern`, `limit`, `clear`. Response bodies via `request_id` (extra) |
| `file_upload`, `upload_image` | Local files into `<input type=file>`; a screenshot (`imageId`) into a file input or dropped at a `coordinate` |
| `gif_creator` | `start_recording` / `stop_recording` / `export` / `clear`. The GIF includes click indicators, action labels and a progress bar |
| `resize_window` | Resize the window |
| `list_connected_browsers`, `select_browser`, `switch_browser` | Multi-browser. `switch_browser` opens a "Connect" window in every browser |
| `handle_dialog`, `download`, `downloads`, `save_pdf`, `cookies`, `history` | Extras not in Claude in Chrome |
| `browser_batch` | Several tools in one call (`{name, input}` or `{tool, args}`; the `mcp__…__` prefix is accepted) |

Text-only models can work with refs alone (`read_page` → `computer {ref}` / `form_input`). Vision models can also use screenshots, where coordinates map 1:1 to clicks.

### Multiple browsers
Install the extension in every Chrome you want to control (other profiles, Chrome Beta, a second machine via port-forward). Each one shows up in `list_connected_browsers`, and you can rename it from the extension popup. When more than one is connected, every MCP session must call `select_browser` (or `switch_browser`) before anything else. Each session keeps its own choice.

## Config
- `KENDALI_PORT` (default `18765`). If you change it, set the same port in the extension popup.
- `KENDALI_EXTENSION_ID`: accept only this extension id.
- `KENDALI_OUT_DIR`: default folder for PDFs and screenshots (`~/Downloads/kendali`).

## Security
- The server binds to `127.0.0.1` only. Connections from web pages are refused (Origin check).
- The agent drives your **logged-in** browser, and page content can contain prompt injection. Use it with models and tasks you trust.
- Tools that use the DevTools protocol show Chrome's "is debugging this browser" bar. This is expected.

## Privacy
Kendali has no backend. It talks only to the MCP server on your own machine (`127.0.0.1`), and nothing is sent anywhere else. See the [privacy policy](https://aswadwk.github.io/kendali/privacy.html).

## License
Copyright © 2026 aswadwk. All rights reserved (see [LICENSE](LICENSE)). The bundled gifenc library is MIT.
