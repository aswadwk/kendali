# Chrome Web Store listing: Kendali – Browser MCP

Copy each field into the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Store listing

**Name** (from manifest): Kendali – Browser MCP

**Summary** (from manifest, ≤132 chars):
Let AI agents (Claude Code, Codex, Gemini CLI, Cursor, OpenCode…) control this browser through a local MCP server.

**Category**: Developer Tools · **Language**: English

**Description**:
```
Kendali lets the AI agent on your computer use your real Chrome browser: open tabs, read pages, click, type, fill forms, upload and download files, take screenshots, record GIFs, run JavaScript and read console and network logs.

It works with any MCP client and any model: Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor, VS Code, Cline, OpenCode, LM Studio and more. Tool names and parameters match Claude in Chrome, so prompts and skills written for Claude in Chrome work unchanged.

HOW IT WORKS
1. Install this extension.
2. Add the MCP server to your AI client: npx -y kendali-mcp
   (for example: claude mcp add kendali -- npx -y kendali-mcp)
3. The extension connects to the server on 127.0.0.1 and your agent can start browsing.

FEATURES
• Page snapshots with element refs, so text-only models can browse without screenshots
• Natural-language find ("search bar", "login button")
• Clicks, typing, key combos, scrolling and drag by ref or coordinate
• Screenshots with zoom and scaling; upload a screenshot into a page
• GIF recording of the agent's steps, with click indicators and labels
• Form filling, file upload, downloads with your browser session, save as PDF
• Console messages, network requests and API response bodies
• Agent tabs kept in their own "Kendali" tab group, separate from yours
• Several browsers at once: list, select or switch between connected browsers
• Batch several actions in one call

PRIVACY
No account, no cloud, no analytics. The extension talks only to the MCP server on your own machine (127.0.0.1). Your AI client may send page content to its model provider; use models you trust.

Docs and source: https://github.com/aswadwk/kendali
```

**Homepage URL**: https://github.com/aswadwk/kendali
**Support URL**: https://github.com/aswadwk/kendali/issues

**Graphics** (in `store/`):
- Icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800: `store/screenshot-1.png`, `store/screenshot-2.png`
- Small promo tile 440×280: `store/promo-small.png`

## Privacy practices

**Single purpose**:
```
Let a local AI agent (an MCP client on the user's own computer) control the browser on the user's behalf: navigate, read pages, interact with elements, take screenshots and manage downloads.
```

**Permission justifications**:

| Permission | Justification |
|---|---|
| tabs | List, open, switch and close tabs that the user's AI agent works in, and report their titles and URLs back to it. |
| tabGroups | Keep the agent's tabs in a separate "Kendali" tab group so they don't mix with the user's own tabs. |
| scripting | Inject the content script that reads the page structure (element refs, text) and performs clicks, typing and form filling requested by the agent. |
| debugger | Send trusted mouse and keyboard input, take screenshots, save pages as PDF, handle JavaScript dialogs and read console and network events of the tab the agent controls. Chrome shows its standard "is debugging this browser" bar while active. |
| downloads | Download files the agent is asked to fetch, and report the saved file path back to it. |
| cookies | Let the agent list, set or remove cookies for a site when the user's task requires it (for example testing a web app). |
| history | Let the agent search the user's browsing history when asked to find a previously visited page. |
| storage | Store the extension's settings: the local server port, a random device ID and the browser name. |
| alarms | Keep the connection to the local MCP server alive and reconnect when the server restarts. |
| identity, identity.email | Read the email of the Google account signed in to this Chrome profile, only to show it to the user's local agent so it can tell several connected profiles apart (no tokens, no sign-in). |
| contentSettings | Read (not change) the "Automatic downloads" site setting, so the agent can tell the user when Chrome is blocking or asking about a download. |
| Host permission `<all_urls>` | The agent can be asked to work on any website the user chooses, so the extension must be able to read and interact with any page. |

**Remote code**: No. All code is in the package. JavaScript strings sent by the user's local agent are executed only in the web page (through the debugger protocol), never in the extension.

**Data usage**: the extension can pass page content to the user's local agent, so check: Personally identifiable information, Authentication information (cookies), Personal communications, Web history, User activity, Website content. Leave the others (health, financial, location) unchecked.
Then certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**: https://aswadwk.github.io/kendali/privacy.html

## Distribution
Visibility: Public · Regions: all · Pricing: free
