// Popup: the only place sharing can be granted, and the place it is always
// visible. Every control here is a deliberate user action — there is no
// "share automatically" anywhere in this extension.

const $ = (id) => document.getElementById(id);

const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url || '';
  }
}

const STATUS = {
  connected: ['Connected', 'connected'],
  connecting: ['Connecting…', 'connecting'],
  disconnected: ['Server not found', 'error'],
  'no-token': ['Not paired', 'error'],
  unauthorized: ['Token rejected', 'error'],
};

async function render() {
  const state = await send({ type: 'get-state' });
  if (!state?.ok) return;

  const [label, cls] = STATUS[state.connection.status] || ['Unknown', 'error'];
  const pill = $('status');
  pill.textContent = state.connection.status === 'connected' ? `${label} :${state.connection.port}` : label;
  pill.className = `pill ${cls}`;
  pill.title = state.connection.lastError || '';

  const needsPairing = ['no-token', 'unauthorized'].includes(state.connection.status);
  $('pairing').hidden = !needsPairing;
  if (needsPairing) {
    $('pairing-hint').textContent =
      state.connection.lastError ||
      'Start the MCP server, then paste the token it wrote to ~/.claude-chrome-bridge/token.json.';
    if (!$('port').value) $('port').value = state.connection.port || 8787;
  }

  // --- this tab -----------------------------------------------------------
  const active = state.activeTab;
  const grant = active && state.grants.find((g) => g.tabId === active.id);
  const card = $('active-tab');
  card.replaceChildren();

  if (!active) {
    card.innerHTML = '<div class="empty">No active tab.</div>';
  } else if (!active.shareable) {
    card.innerHTML =
      `<div class="title">${escapeHtml(active.title || '(untitled)')}</div>` +
      `<div class="url">${escapeHtml(shortUrl(active.url))}</div>` +
      '<div class="empty">Chrome internal pages cannot be shared.</div>';
  } else {
    card.innerHTML =
      `<div class="title">${escapeHtml(active.title || '(untitled)')}</div>` +
      `<div class="url">${escapeHtml(shortUrl(active.url))}</div>`;
    const row = document.createElement('div');
    row.className = 'row spread';
    if (grant) {
      row.appendChild(controlToggle(grant));
      row.appendChild(button('Stop sharing', async () => {
        await send({ type: 'unshare', tabId: grant.tabId });
        toast('Sharing stopped.');
        render();
      }));
    } else {
      const share = button('Share this tab', async () => {
        const res = await send({ type: 'share' });
        toast(res.ok ? 'Shared read-only with Claude.' : res.error);
        render();
      }, 'primary');
      row.appendChild(share);
      const note = document.createElement('span');
      note.className = 'hint';
      note.textContent = 'Read-only until you allow control.';
      row.prepend(note);
    }
    card.appendChild(row);
  }

  // --- everything currently shared ---------------------------------------
  $('shared-count').textContent = state.grants.length;
  const list = $('shared-list');
  list.replaceChildren();
  if (!state.grants.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing is shared. Claude cannot see any tab.';
    list.appendChild(li);
  }
  for (const g of state.grants) {
    const li = document.createElement('li');
    li.className = 'tab';
    li.innerHTML =
      `<div class="row spread"><span class="title">${escapeHtml(g.title || '(untitled)')}</span>` +
      `<span class="badge ${g.control ? 'rw' : 'r'}">${g.control ? 'read + control' : 'read only'}</span></div>` +
      `<div class="url">${escapeHtml(shortUrl(g.url))}</div>`;
    const row = document.createElement('div');
    row.className = 'row spread';
    row.appendChild(controlToggle(g));
    row.appendChild(button('Stop', async () => {
      await send({ type: 'unshare', tabId: g.tabId });
      toast('Sharing stopped.');
      render();
    }));
    li.appendChild(row);
    list.appendChild(li);
  }

  $('idle-hint').textContent =
    `Sharing ends automatically when a tab closes, navigates to a different site, or sits unused for ` +
    `${state.idleTimeoutMinutes} minutes.`;
}

function controlToggle(grant) {
  const label = document.createElement('label');
  label.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(grant.control);
  input.addEventListener('change', async () => {
    const res = await send({ type: 'set-control', tabId: grant.tabId, control: input.checked });
    toast(res.ok
      ? (input.checked ? 'Claude can now click and type in this tab.' : 'Control revoked — reading only.')
      : res.error);
    render();
  });
  label.append(input, document.createTextNode('Allow control'));
  label.title = 'Lets Claude click, type, scroll and navigate in this tab.';
  return label;
}

function button(text, onClick, className = '') {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('save-token').addEventListener('click', async () => {
  const token = $('token').value.trim();
  if (!token) return toast('Paste the token first.');
  const port = Number($('port').value) || 8787;
  await send({ type: 'set-port', port });
  await send({ type: 'set-token', token });
  $('token').value = '';
  toast('Pairing…');
  setTimeout(render, 700);
});

$('panic').addEventListener('click', async () => {
  const res = await send({ type: 'panic' });
  toast(res.ok ? `Stopped sharing ${res.revoked.length} tab(s).` : res.error);
  render();
});

render();
setInterval(render, 2000);
