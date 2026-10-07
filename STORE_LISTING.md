# Chrome Web Store listing

Everything needed for submission. The `debugger` permission draws manual review — the
justifications below are written to be pasted verbatim into the dashboard.

---

## Item name

`Porthole`

## Short description (132 char max)

> Let your AI coding agent see the tabs you choose — in your real Chrome, already logged in. Per-tab opt-in. Nothing leaves your machine.

_(129 characters.)_

## Category

Developer Tools

## Detailed description

> **Your AI coding agent can read your code. It cannot see your browser. Porthole fixes that
> — one tab at a time.**
>
> When you are debugging a web app, an OAuth flow, or some opaque third-party console, you end
> up transcribing what is on screen by hand: copying error text, describing what a page looks
> like, re-typing IDs. Porthole removes that step. Your agent reads the page itself.
>
> It works in the Chrome you already use, with the sessions you are already logged into. No
> separate debug browser, no relaunching with special flags, no signing into everything again.
>
> **Works with Claude Code** and any client that speaks the Model Context Protocol.
>
> ---
>
> **You decide what it sees, one tab at a time**
>
> Nothing is visible until you click Share this tab on that specific tab. There is no "share
> everything", and unshared tabs cannot even be listed.
>
> **Reading and control are separate permissions**
>
> Sharing a tab lets your agent read it. Clicking, typing and navigating need a second toggle
> you enable per tab — and it never survives a revoke.
>
> **You can always tell**
>
> Shared tabs carry a badge, the popup lists everything currently shared, and Chrome shows its
> own "is debugging this browser" banner, which Porthole never suppresses. One click stops
> everything.
>
> **Sharing ends by itself**
>
> When the tab closes, when it navigates to a different site, after 30 idle minutes, and when
> the browser session ends.
>
> **Passwords are never read**
>
> The value of a password field is never captured — not masked afterwards, never read. Fields
> that look like secrets, and credentials that appear in page text or URLs (API keys, JWTs,
> bearer tokens, OAuth codes) are masked as well.
>
> **Nothing leaves your computer**
>
> No accounts, no analytics, no telemetry, no cloud. The extension connects only to a program
> on your own machine over localhost, authenticated with a token you paste once. Whatever you
> deliberately share then goes to your AI agent, under that agent's own privacy policy.
>
> ---
>
> **Setup (two minutes)**
>
> 1. `npx claude-chrome-bridge setup`
> 2. Paste the token it prints into this extension
> 3. Open a tab, click Porthole, choose Share this tab
>
> Open source, MIT licensed: https://github.com/rana3128/claude_chrome_bridge

## Single purpose (required)

> Porthole's single purpose is to let a local AI coding assistant read and, with separate
> explicit permission, interact with specific browser tabs that the user has individually
> chosen to share with it.

## Permission justifications

**`debugger`**

> Required to read the accessibility tree of a shared tab, capture screenshots (including
> full-page, which needs the DevTools Protocol), collect console messages and failed network
> requests, and dispatch trusted input events for the optional control feature. It is used only
> on tabs the user has explicitly shared, attached at the moment of sharing and detached when
> sharing ends. Chrome's own debugging banner is never suppressed or circumvented. Existing
> APIs cannot provide the accessibility tree, full-page capture, or console/network capture.

**`tabs`**

> Used to read the title and URL of tabs the user has shared so they can be identified in the
> extension popup and reported to the user's agent, and to detect when a shared tab is closed
> or navigates to a different origin so that sharing can be revoked automatically.

**`activeTab`**

> Grants access to the tab the user clicked the extension on, used for the read-only fallback
> path when the debugger cannot attach — most commonly because the user has DevTools open on
> that tab.

**`scripting`**

> Executes that read-only fallback in the shared tab: collecting visible text and the
> attributes of elements matching a selector. It runs only on tabs the user shared, and only
> when the debugger is unavailable.

**`storage`**

> Stores the user's pairing token and port setting locally, plus the list of currently shared
> tabs (in session storage, so it is cleared when the browser session ends).

**`alarms`**

> Periodically wakes the extension's service worker to re-establish its localhost connection
> after MV3 evicts it, and to expire shares that have been idle for 30 minutes.

**Remote code**

> None. The extension contains no remote code, no eval of fetched content, and loads no
> external scripts. All logic ships in the package.

## Data usage disclosures

| Question | Answer |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No — password fields are never read, and credential-shaped values are masked |
| Personal communications | No |
| Location | No |
| Web history | No — only tabs the user explicitly shares, and only while shared |
| User activity | No |
| Website content | **Yes** — the content of tabs the user explicitly shares, sent only to a program on the user's own machine |

Certifications:
- Not being sold to third parties ✔
- Not being used or transferred for purposes unrelated to the item's single purpose ✔
- Not being used or transferred to determine creditworthiness or for lending ✔

## Privacy policy URL

`https://github.com/rana3128/claude_chrome_bridge/blob/main/PRIVACY.md`

## Assets still to produce

- [ ] Screenshots, 1280×800 or 640×400 — at least one, up to five. Suggested:
      1. Popup with one tab shared, read-only
      2. A shared tab showing both the badge and Chrome's debugging banner
      3. The agent reading a page (terminal beside browser)
      4. The popup's Allow control toggle
      5. The welcome/onboarding page
- [ ] Small promo tile, 440×280 (required for a public listing)
- [ ] Marquee promo tile, 1400×560 (optional, needed for featuring)

## Submission notes

- Publisher account requires a one-time $5 registration fee.
- Expect a longer review because of `debugger`. Reviewers respond well to the single-purpose
  statement and to the fact that the banner is never suppressed.
- The extension is useless without the companion npm package; say so in the description, or
  reviewers may report it as non-functional. The onboarding page opens on install and explains
  the `npx` step, which also helps here.
