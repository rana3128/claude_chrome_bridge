# Decisions

Judgement calls made while building, and why. Newest sections last.

## Transport and pairing

**Fixed default port 8787, with the server walking forward and the extension sweeping.**
An MV3 extension cannot be handed a port at launch, and asking the user to retype one on
every conflict is hostile. The server tries 8787–8796 and the extension cycles the same
range across reconnect attempts, so a stale process on 8787 costs a few seconds, not a
support incident. The chosen port is shown in the popup pill.

**Token stored in `~/.claude-chrome-bridge/token.json` (0600), pasted into the popup once.**
A file is the only channel both a stdio MCP server and a browser extension can reach without
a network service. Comparison is constant-time. A rejected token stops the reconnect loop
entirely and asks the user to re-pair, rather than hammering the port forever — a wrong token
will stay wrong.

**The extension connects to every server in the port range at once.** Originally it dialled
one port and stopped, which was wrong: every Claude Code session spawns its own MCP server,
they land on consecutive ports, and the extension would pair with whichever won the race.
Any other session was then permanently blind, with a popup cheerfully reporting "Connected"
and tools reporting "extension not connected" — the two ends disagreeing with no way for the
user to see why. Now every port in the window gets its own link, commands are answered on the
socket they arrived on, and all sessions share the same grants. The popup lists each connected
server by port and project directory so "connected" is never ambiguous about *which* session.

**Dials have a 3-second deadline.** A dial to a port with nothing behind it does not reliably
report failure — no `close` event arrives at all in some environments. Without a deadline that
slot sits in `connecting` forever and is never retried, so a server started later is never
found. This was a real bug, caught by the multi-server test.

**Unknown ports are probed one per sweep, in rotation.** Chrome logs every refused WebSocket
dial to the console and it cannot be caught or silenced, so probing all ten ports every 20
seconds buried real errors under `ERR_CONNECTION_REFUSED`. Ports that have answered before are
remembered in `chrome.storage.local` and always retried; unknown ones come up in rotation. That
trades a slightly slower first discovery of a brand-new port for a console that is readable,
and Reconnect still probes everything at once.

**Discovery re-sweeps every 20 seconds once at least one server is connected**, with
exponential backoff up to 30s when none is. A new session's server is therefore picked up
within ~20 seconds; the popup's **Reconnect** button forces it immediately.

**One authenticated connection at a time per server; a new `hello` replaces the old socket (close 4409).**
Service worker restarts routinely leave a half-dead socket behind. Newest-wins is the only
rule that makes reconnection reliable.

**Malformed frames close the connection instead of being ignored.** This link is
security-relevant; a peer that can't speak the protocol correctly does not get to keep trying.

## Where code lives

**`extension/lib/protocol.js` and `extension/lib/redact.js` are canonical; the server imports
them by relative path.** Both sides must agree exactly on the wire format and on what counts
as a secret. An unpacked extension can't import from outside its own directory, so the shared
files live inside `extension/` and Node reaches in. One copy, one set of tests.

**Redaction runs twice — in the extension and again in the server.** Cheap, and it means a
bug in one layer isn't a leak.

## Browser access

**`chrome.debugger` is the primary execution path; `chrome.scripting` is a fallback.**
The debugger API is what makes the user's real, logged-in Chrome usable without a relaunch,
and it is the only way to get the accessibility tree, full-page screenshots, console/network
capture, and trusted input events. It also forces Chrome's own "is debugging this browser"
banner, which is exactly the visibility this tool should have. `chrome.scripting` (with
`activeTab`, not `<all_urls>`) covers read-only text/query when the debugger can't attach —
almost always because DevTools is open on that tab.

**No `<all_urls>` host permission.** Everything runs through the debugger, and the scripting
fallback rides on `activeTab`, which the user grants by clicking the extension on that tab.
An extension with this much reach should not also ask for blanket host access.

**Attach at share time, not at first tool call.** So the banner appears the moment sharing
starts (no silent gap), and console/network capture begins immediately rather than missing
everything before the first `console_logs`.

**Input goes through CDP `Input.dispatch*` at element coordinates, not `el.click()`.**
Synthetic DOM events are ignored by plenty of frameworks and by anything checking
`isTrusted`. Coordinates come from a `getBoundingClientRect` after `scrollIntoView`.

**Cross-origin iframes are read via flat auto-attach.** `Target.setAutoAttach` gives a
session per OOPIF; `read_page` appends each one under a labelled marker, so an embedded
checkout or OAuth form is not an invisible hole in the output.

## Permissions

**Grants live in `chrome.storage.session`, keyed by tab id.** They die with the browser
session by construction — a share can never silently survive a restart.

**Every command re-authorizes against the store, in the extension.** The server never asserts
permission; it only asks. Compromising the server therefore does not grant access to a tab
the user hasn't shared.

**Control does not survive a revoke.** Re-sharing a tab always starts read-only, even if it
previously had control. Re-granting must be a deliberate act.

**Idle timeout is 30 minutes, refreshed by use.** Long enough for a real debugging session
with pauses, short enough that a forgotten share expires the same afternoon.

**Same-origin navigation keeps the share; cross-origin revokes it.** Following a link within
an app you are debugging shouldn't drop the connection, but landing anywhere else must.

**Chrome's own "Cancel" on the debugging banner is treated as revocation.** If the user ends
the debug session, they ended the share too.

## Output

**Accessibility tree is the default read mode.** Smaller than the DOM and closer to meaning.
Presentational roles are collapsed with their children lifted, unnamed uninteresting nodes are
dropped, and the count of collapsed nodes is reported so the compaction is not invisible.

**Interactive a11y nodes carry `ref=N` (a CDP backendDOMNodeId), and `click`/`type` accept
`ref=N` as a selector.** Otherwise every read would need a follow-up lookup to find a CSS
selector for the thing you just read about.

**Every truncation names its numbers and its escape hatch.** `[TRUNCATED: showing X of Y
characters (Z%). <what to call next>]`. Silent truncation makes a model confidently wrong.

**Only failed and non-2xx requests are retained.** Successful traffic would swamp the budget
and is almost never what you are debugging.

**Screenshots downscale via CDP `clip.scale`.** The protocol can't resize output, but the
clip rect can, so a 4K page arrives at 1280px wide without a separate image pipeline.

## Testing

**The fake in-memory tab (`--fake-tab`, id `fake:1`) is a shipped feature, not a test
fixture.** It proves the entire tool surface — including the read/control split and the
redaction rules — over real MCP stdio with no browser involved, and it makes the server
debuggable in isolation.

**The extension's permission store is tested under Node with a small `chrome` stub.**
It is the security core; testing it only by hand in a browser was not acceptable.
