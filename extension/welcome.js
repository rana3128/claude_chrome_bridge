// First-run onboarding. Pairing from here means a new user never has to find
// the popup before anything works.

const form = document.getElementById('pair-form');
const input = document.getElementById('token');
const status = document.getElementById('pair-status');

function report(text, ok = false) {
  status.textContent = text;
  status.style.color = ok ? 'var(--ok)' : 'var(--warn)';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = input.value.trim();
  if (!token) return report('Paste the token that `npx claude-chrome-bridge setup` printed.');

  await chrome.runtime.sendMessage({ type: 'set-token', token });
  input.value = '';
  report('Pairing…');

  // Give the socket a moment to come up before reporting either way.
  setTimeout(async () => {
    const state = await chrome.runtime.sendMessage({ type: 'get-state' });
    const status = state?.connection?.status;
    if (status === 'connected') report('Paired. Open a tab and click the Porthole icon to share it.', true);
    else if (status === 'unauthorized') report('That token was rejected. Run `npx claude-chrome-bridge pair` to see the current one.');
    else report('Paired, but no bridge is running yet. Start Claude Code, then click Reconnect in the popup.');
  }, 1200);
});
