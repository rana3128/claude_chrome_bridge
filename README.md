<div align="center">

# Porthole

**Your AI coding agent can read your code. It can't see your browser.**
Porthole fixes that — one tab at a time.

[![tests](https://github.com/rana3128/claude_chrome_bridge/actions/workflows/test.yml/badge.svg)](https://github.com/rana3128/claude_chrome_bridge/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Debugging a web app, an OAuth flow, or some opaque third-party console usually means
transcribing the screen by hand — copying error text, describing layouts, re-typing IDs, and
losing the details that mattered. Porthole lets your agent read the page itself.

It runs in **the Chrome you already use**, with the sessions you're already logged into. No
separate debug browser, no relaunching with `--remote-debugging-port`, no signing back into
everything. That constraint is the whole point: being already logged into AWS, Stripe or Meta
Business Manager is exactly what makes the page worth reading.

Works with **Claude Code**, and any client that speaks the Model Context Protocol.

```
your agent ──MCP over stdio──▶ bridge (Node, on your machine)
                                   │  WebSocket, 127.0.0.1 only, token-authenticated
                                   ▼
                          Porthole extension (Chrome)
                                   │
                                   ▼
                        only the tabs you chose to share
```

The extension dials **out**, so your browser never opens an inbound port.

---

## Quick start

You need **Node 20+**, **Chrome**, and **Claude Code** (or another MCP client). Setup is two
one-time steps: register the bridge with your agent, then install and pair the extension.

### 1. Install the bridge and register it with Claude Code

```bash
git clone https://github.com/rana3128/claude_chrome_bridge
cd claude_chrome_bridge
npm install
npm run setup
```

`setup` registers the `chrome-bridge` MCP server with Claude Code for every project and prints
your **pairing token**. Restart any running Claude Code session to pick it up.

> Not using Claude Code, or `claude` isn't on your PATH? `setup` prints a JSON snippet to paste
> into your MCP client's config instead. It looks like this:
>
> ```json
> {
>   "mcpServers": {
>     "chrome-bridge": {
>       "command": "node",
>       "args": ["/absolute/path/to/claude_chrome_bridge/server/src/index.js"]
>     }
>   }
> }
> ```

### 2. Load the extension in Chrome

1. Open `chrome://extensions` and switch on **Developer mode** (top right)
2. Click **Load unpacked** and choose the [extension/](extension/) folder
   (`npm run setup` prints its path; so does `node server/src/index.js extension`)
3. Pin the **Porthole** icon to your toolbar
4. Click the icon, paste the pairing token, press **Pair**

If you lose the token, `npm run pair` prints it again.

The popup should now say it's connected. If it doesn't, see [Troubleshooting](#troubleshooting).

## Using it

1. Open the tab you want help with
2. Click the Porthole icon → **Share this tab**
3. Ask your agent in plain language

> *"Read the shared tab and tell me why the submit button is disabled"*
> *"Screenshot the tab, then check the console for errors"*
> *"Why is this page's network request failing?"*
> *"Fill in the form with test data and submit it"* — needs **Allow control**

Your agent only ever sees tabs you have shared. It starts with `list_tabs`, then reads with
`read_page`, `screenshot_tab`, `console_logs` and so on.

**Allow control.** Sharing is read-only by default. To let the agent click, type, scroll or
navigate, open the popup and turn on **Allow control** for that tab. Turn it off again when
you're done.

**Stop sharing.** Click **Stop** next to the tab in the popup, close the tab, or use the
panic button to revoke everything at once. Sharing also ends on its own if the tab navigates to
another site or sits idle for 30 minutes.

Chrome shows its own *"Porthole is debugging this browser"* banner on shared tabs. That banner
is intentional: it's how you can always tell what's being watched. Closing it stops sharing.

### Try it without a browser

```bash
npm run dev -- --fake-tab
```

exposes an in-memory tab (`fake:1`) so you can exercise every tool with no Chrome involved.

### Command reference

| Command | What it does |
|---|---|
| `npm run setup` | Register with Claude Code and print the token (`--local` for this project only) |
| `npm run pair` | Reprint the pairing token |
| `node server/src/index.js extension` | Print the extension folder path |
| `node server/src/index.js --new-token` | Rotate the token (you must re-pair the extension) |
| `--port <n>` | Listen on a different port (default 8787, walks forward if taken) |

## What your agent gets

| Tool | What it does |
|---|---|
| `list_tabs` | Shared tabs only: id, title, URL, whether control is allowed |
| `screenshot_tab` | JPEG q70, downscaled to 1280px by default; `fullPage` for below the fold |
| `read_page` | `a11y` (default), `text`, or `html` |
| `query` | Text and attributes of elements matching a selector |
| `console_logs` | Console output and uncaught exceptions |
| `network_errors` | Failed and non-2xx requests, CORS and CSP violations |
| `click` · `type` · `scroll` · `navigate` | **Require "Allow control"** |
| `wait_for` | Wait for a selector or a navigation — read-only |

**Output is budgeted, because context is the scarce resource.** `read_page` defaults to the
accessibility tree: smaller than the DOM and closer to meaning, with presentational wrappers
collapsed and duplicate text dropped. Every truncation says what was cut and how to fetch the
rest. Interactive elements carry a `ref=N` handle that `click` and `type` accept, so your agent
can act on what it just read without a second lookup.

## Security

This tool can see whatever is on a page you share. That is treated as the central design
constraint, not a later hardening pass.

| Guarantee | How |
|---|---|
| **Per-tab opt-in** | Sharing happens only from the popup, one tab at a time. There is no "all tabs" |
| **Read-only by default** | `click` / `type` / `scroll` / `navigate` are refused until you enable **Allow control** on that tab |
| **Always visible** | Per-tab badge, a live list in the popup, and Chrome's own debugging banner — never suppressed |
| **Localhost only** | Binds `127.0.0.1`; non-loopback peers and web-page origins are refused at the handshake |
| **Paired with a secret** | 256-bit token in a `0600` file; unauthenticated sockets are closed immediately |
| **Auto-revoke** | Tab closed, navigated to another site, debugger detached, or idle 30 minutes |
| **Passwords never read** | `input[type=password]` values are never captured — not masked afterwards, never read |
| **Credentials masked** | JWTs, API keys, AWS keys, bearer tokens, private keys, OAuth codes in URLs |
| **Panic button** | One click revokes every share and detaches every debugger |

Permission is re-checked **in the extension** on every command — the bridge can only ask, never
assert. Grants live in session storage, so they cannot outlive the browser session.

No accounts, no telemetry, no analytics, no cloud. See [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](SECURITY.md).

**One thing to be deliberate about:** sharing a tab sends that page's content to your AI
provider, under *their* privacy policy. Don't share a tab you wouldn't be willing to send them.

## Troubleshooting

**Popup says "No server found".** No bridge is running. Start your agent, or run
`npm start` yourself. Click **Reconnect** in the popup to redial immediately.

**Popup says "Token rejected".** The token was rotated. `npm run pair` prints
the current one.

**"Another debugger is already attached".** You have DevTools open on that tab; Chrome allows
only one debugger client per tab. Close it, or use another tab. Text and query reads fall back
to `chrome.scripting` automatically — screenshots, the a11y tree, console/network capture and
control need the debugger.

**A tool says the extension isn't connected.** Chrome puts MV3 service workers to sleep. It
reconnects on its own within ~30 seconds, or immediately when you open the popup.

**Console logs are empty.** Capture starts when you share the tab. Reload the page to catch
output from page load.

**Several agent sessions at once.** Supported — each session runs its own bridge on the next
free port and the extension connects to all of them. Note that a shared tab is visible to
*every* running session.

**`ERR_CONNECTION_REFUSED` in the extension console.** Expected. Finding bridges means dialling
ports, and Chrome logs every refused dial with no way to silence it.

## Development

```bash
npm install
npm test                    # 91 tests: protocol, redaction, truncation, permissions, e2e MCP
npm run dev                 # bridge with verbose logging
npm run dev -- --fake-tab   # exposes an in-memory tab, so the tools work with no browser at all
npm run package:extension   # build the Chrome Web Store zip
```

```
server/src/        bridge (stdio MCP + WebSocket), tools, redaction, truncation, CLI
server/test/       protocol, redaction, truncation, a11y, grants, connection, bridge, e2e
extension/         MV3 extension, vanilla JS, no build step
extension/lib/     protocol.js and redact.js are shared with the server — one copy, one set of tests
DECISIONS.md       why it is built this way
STORE_LISTING.md   Chrome Web Store copy and permission justifications
```

Contributions welcome, particularly around redaction coverage and reducing output size.

## License

MIT — see [LICENSE](LICENSE).
