# kendali-mcp

MCP server for the **Kendali** Chrome extension. It lets any MCP client (Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, OpenCode, LM Studio…) control your real Chrome browser. Tool names and parameters match Claude in Chrome.

1. Load the `extension/` folder of https://github.com/aswadwk/kendali as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
2. Add the server to your MCP client:

```bash
claude mcp add kendali -- node /path/to/kendali/mcp-server/index.js   # Claude Code
```
```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.kendali]
command = "node"
args = ["/path/to/kendali/mcp-server/index.js"]
```
```json
{ "mcpServers": { "kendali": { "command": "node", "args": ["/path/to/kendali/mcp-server/index.js"] } } }
```

The extension badge shows **ON** when it is connected. Full docs: https://github.com/aswadwk/kendali
