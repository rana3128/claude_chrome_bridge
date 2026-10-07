# Privacy Policy — Porthole

_Last updated: 6 September 2026_

Porthole is a Chrome extension and a local companion program that let an AI coding agent —
such as Claude Code — read tabs you explicitly share with it.

## The short version

**Porthole has no servers.** There is no Porthole account, no analytics, no telemetry, no
crash reporting, and no cloud component of any kind. The extension talks to one thing: a
program running on your own computer, over `127.0.0.1` (localhost), which never leaves your
machine.

We — the authors of Porthole — receive nothing. We cannot see your tabs, your browsing, or
even that you installed it.

## What is accessed, and when

Nothing is accessed until you click **Share this tab** on a specific tab. There is no
"share everything" mode, and unshared tabs cannot be listed or read.

Once you share a tab, the local bridge can read, **for that tab only**:

- the page's text, structure (accessibility tree) and HTML
- screenshots of it
- its URL and title
- console messages and failed network requests it produces

If you additionally enable **Allow control** for that tab, the bridge can also click, type,
scroll and navigate in it.

## Where that data goes

To the program running on your own computer, and from there to the AI coding agent you
connected — that agent is a separate product with its own privacy policy, and what it does
with the content (including sending it to a model provider) is governed by *that* policy, not
this one. Choosing to share a tab with an agent means sending that page's content to whatever
service that agent uses.

Porthole itself stores, in your browser's local storage: your pairing token, the port to
connect to, and the list of tabs currently shared. Console and network buffers for shared tabs
are held in session storage and are discarded when the browser session ends.

## What is never captured

- **Password fields.** The value of any `input[type=password]` is never read — not to be
  masked later, not at all.
- Values in fields whose name, id, placeholder, label or autocomplete hint identifies them as
  secret (tokens, API keys, OTP codes, CVV, SSN, and similar) are replaced with `[REDACTED]`.
- Recognisable credentials in page text and URLs — JWTs, API keys, AWS keys, bearer tokens,
  private key blocks, OAuth codes and access tokens in query strings — are masked.

These are best-effort protections against accidental capture, not a guarantee. A page can
always display a secret as ordinary text. **Do not share a tab whose contents you would not
be willing to send to your AI provider.**

## How sharing ends

Automatically when: the tab closes, the tab navigates to a different site, the debugger is
detached, the tab sits unused for 30 minutes, or the browser session ends. Immediately, at
any time, via **Stop sharing** on one tab or **Stop all sharing** in the popup.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `debugger` | Reads the accessibility tree, captures screenshots and console/network activity, and sends real input events — for shared tabs only. This is also why Chrome displays its own "is debugging this browser" banner, which we never suppress. |
| `tabs` | Reads the title and URL of shared tabs, and detects when one closes or navigates so sharing can be revoked. |
| `activeTab` | Lets the read-only fallback work on the tab you clicked the extension on, when the debugger is unavailable. |
| `scripting` | Runs that read-only fallback (visible text, element queries) when DevTools is holding the debugger. |
| `storage` | Stores your pairing token, port, and the current sharing state. |
| `alarms` | Wakes the extension periodically to reconnect and to expire idle shares. |

Porthole requests no host permissions, so it has no standing access to any website.

## Children

Porthole is a developer tool and is not directed at children under 13.

## Changes

Material changes will be noted here and in the repository's release notes.

## Contact

Issues and security reports: https://github.com/rana3128/claude_chrome_bridge/issues
