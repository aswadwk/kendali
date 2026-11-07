# kendali-mcp

MCP server for the **Kendali** Chrome extension. It lets any MCP client (Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, OpenCode, LM Studio…) control your real Chrome browser. Tool names and parameters match Claude in Chrome.

1. Install the **Kendali – Browser MCP** extension from the Chrome Web Store.
2. Add the server to your MCP client:

```bash
claude mcp add kendali -- npx -y kendali-mcp            # Claude Code
```
```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.kendali]
command = "npx"
args = ["-y", "kendali-mcp"]
```
```json
{ "mcpServers": { "kendali": { "command": "npx", "args": ["-y", "kendali-mcp"] } } }
```

The extension badge shows **ON** when it is connected. Full docs: https://github.com/aswadwk/kendali
