# Security Policy

Porthole can see whatever is on a page you share — including banking, email and private
messages if you share those tabs. We take reports seriously.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/vijaysingh/porthole/security/advisories/new)
rather than a public issue. Please include what you did, what happened, and what you expected.

Expect an acknowledgement within 72 hours.

## What counts

Especially interested in anything that lets a party other than the user's own MCP client:

- read or control a tab the user did not share
- act on a shared tab without the separate **Allow control** grant
- connect to the local bridge without the pairing token, or from a non-loopback origin
- keep access after a revocation (tab closed, origin changed, idle timeout, panic button)
- cause a password field's value, or a masked credential, to reach the client

## Design constraints we hold ourselves to

- Nothing is readable until the user shares that specific tab.
- Reading and control are separate grants; control never survives a revoke.
- The WebSocket binds `127.0.0.1` only, requires the pairing token, and rejects web-page origins.
- Chrome's own debugging banner is never suppressed or worked around.
- Permission is re-checked in the extension on every command — the server can only ask.

## Scope

Out of scope: physical access to an unlocked machine, malicious extensions already installed
with `debugger` permission, and what your AI provider does with content you deliberately shared.
