# Claude Chrome Bridge

Lets Claude Code see and control tabs in **your existing Chrome**, with your real logged-in
sessions intact. No relaunching Chrome with `--remote-debugging-port`, no fresh headless
profile, no re-authenticating with Facebook / AWS / Stripe just so a tool can look at them.

Nothing is visible to Claude until you explicitly share a specific tab, and sharing grants
reading only — clicking and typing is a second, separate toggle.

```
Claude Code ──MCP over stdio──▶ MCP server (Node)
                                     │  WebSocket, 127.0.0.1 only, token-authenticated
                                     ▼
                            Chrome extension (MV3)
                                     │  chrome.debugger / chrome.scripting
                                     ▼
                          the tabs you chose to share
```

The extension dials **out** to the server, so the browser never opens an inbound port.

---

## Setup

### 1. Install the server dependencies

```bash
cd claude_chrome_bridge
npm run install:all
```

Node 20+ required (tested on 22).

### 2. Register the MCP server with Claude Code

Either run:

```bash
claude mcp add chrome-bridge -- node /ABSOLUTE/PATH/TO/claude_chrome_bridge/server/src/index.js
```

…or add this to your Claude Code MCP config by hand (`~/.claude.json`, or `.mcp.json` in a
project). This is the exact JSON:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/claude_chrome_bridge/server/src/index.js"]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO` with the real path. Claude Code launches this process itself —
you do not start it manually for normal use.

### 3. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder in this repo
4. Pin the extension so you can see the badge on shared tabs

### 4. Pair once with the token

The server writes a token on first run to:

```
~/.claude-chrome-bridge/token.json
```

Start Claude Code once (so the server runs and creates the file), then:

```bash
cat ~/.claude-chrome-bridge/token.json
```

Copy the `token` value, click the extension icon, paste it into **Pairing token**, and press
**Pair**. The popup pill should turn to **Connected**. You only do this once — the token
persists until you rotate it.

To print the token directly instead: `npm run dev -- --print-token`.
To rotate it: `node server/src/index.js --new-token` (then re-paste into the popup).

### 5. Share a tab

Open the tab you want Claude to see → click the extension icon → **Share this tab**.

- A badge appears on the tab: `R` (read-only) or `RW` (read + control)
- Chrome shows its own *"Claude Chrome Bridge is debugging this browser"* banner. That is
  expected and deliberate — closing it stops sharing
- Flip **Allow control** only when you want Claude to click, type, scroll or navigate

Now ask Claude: *"list my shared tabs and read the page"*.

---

## Development

```bash
npm run dev      # start the server standalone with verbose logging on stderr
npm test         # protocol, redaction, truncation, permission and end-to-end MCP tests
```

`npm run dev` is only for poking at the server directly; Claude Code starts its own copy.

To exercise every tool without any browser at all, run the server with a fake in-memory tab:

```bash
node server/src/index.js --fake-tab
```

It appears as tab id `fake:1` and responds to every tool, including the permission gates.

---

## Tools

| Tool | What it does |
|---|---|
| `list_tabs` | Shared tabs only: id, title, URL, and whether control is allowed |
| `screenshot_tab(tabId, {fullPage, maxWidth, format})` | JPEG q70 downscaled to 1280px by default |
| `read_page(tabId, {mode, selector})` | `a11y` (default), `text`, or `html` |
| `query(tabId, selector)` | Text and attributes of matching elements |
| `console_logs(tabId, {since, level})` | Console output and uncaught exceptions, via CDP |
| `network_errors(tabId, {since})` | Failed and non-2xx requests, CORS and CSP violations |
| `click(tabId, selector \| {x,y})` | **Needs "Allow control"** |
| `type(tabId, selector, text, {submit})` | **Needs "Allow control"** |
| `scroll(tabId, …)` · `navigate(tabId, url)` | **Needs "Allow control"** |
| `wait_for(tabId, {selector \| navigation, timeout})` | Read-only |

**Token efficiency.** `read_page` defaults to the accessibility tree because it is smaller
than the DOM and closer to meaning: presentational wrappers are collapsed and unnamed nodes
dropped. Everything is budgeted, and every cut leaves an explicit marker saying how much was
lost and how to fetch more. Interactive nodes carry a `ref=N` handle that `click` and `type`
accept, so you can act on what you read without a second lookup.

---

## Security model

| Guarantee | How |
|---|---|
| Per-tab opt-in | Sharing happens only from the popup, one tab at a time. There is no "all tabs" |
| Read-only by default | `click` / `type` / `scroll` / `navigate` are refused until **Allow control** is on |
| Always visible | Per-tab badge, a live list in the popup, plus Chrome's own debugging banner (never suppressed) |
| Localhost only | Server binds `127.0.0.1`; non-loopback peers and web-page origins are refused at the handshake |
| Paired with a secret | 256-bit token in a `0600` file; unauthenticated sockets are closed with 4401 |
| Auto-revoke | Tab closed, navigated to a different origin, debugger detached, or idle for 30 minutes |
| Redaction | `input[type=password]` values are never read at all; secret-shaped values (JWTs, API keys, AWS keys, bearer tokens, PEM blocks, tokens in URLs) are masked in every output path |
| Panic button | One click in the popup revokes every share and detaches every debugger |

Grants live in `chrome.storage.session`, so they cannot outlive the browser session. Every
command re-checks permission against that store — never against anything the server claims.

---

## Troubleshooting

**Popup says "No server found".** Claude Code hasn't started the server yet — run any
`chrome-bridge` tool. Don't start one manually as well; each Claude Code session already
spawns its own.

**Several Claude Code sessions at once.** This is handled: each session's server takes the
next free port (8787, 8788, …) and the extension keeps a link to *all* of them, so every
session can see the tabs you share. The popup lists them by port and project directory.
A newly started session is found within ~20 seconds, or immediately via **Reconnect**.

**Popup shows the wrong state, or a session can't see a shared tab.** Click **Reconnect** in
the popup — it drops every link and redials the whole port range at once.

**Popup says "Token rejected".** The token was rotated. Re-copy it from
`~/.claude-chrome-bridge/token.json` and paste it again.

**"another debugger is already attached".** You have DevTools open on that tab. Chrome allows
only one debugger client per tab — close DevTools, or use a different tab. Read-only text and
query calls fall back to `chrome.scripting` automatically; screenshots, the a11y tree, console
and network capture, and all control tools need the debugger.

**A tool says the extension is not connected.** MV3 puts the service worker to sleep. It
reconnects on its own within ~30 seconds, or immediately if you open the popup.

**Console logs are empty.** Capture starts when the tab is shared. Reload the page to catch
output from page load.

**Screenshots look slightly off.** Chrome's debugging banner shifts the page down a few
pixels. That is the banner working as intended.

**Chrome internal pages can't be shared.** `chrome://` URLs and the Web Store are closed to
all extensions.

## Layout

```
server/          MCP server (stdio) + WebSocket bridge
  src/           index.js · bridge.js · tools.js · truncate.js · token.js · fake-tab.js
  test/          protocol, redaction, truncation, a11y, grants, bridge, end-to-end MCP
extension/       MV3 extension, vanilla JS, no build step
  lib/           protocol.js · redact.js · grants.js · cdp.js · commands.js · a11y.js …
  background.js  service worker: connection, auto-revoke, popup messaging
DECISIONS.md     why this is built the way it is
```

`extension/lib/protocol.js` and `extension/lib/redact.js` are the single source of truth for
the wire format and the redaction rules; the server imports those files directly rather than
keeping a second copy.
