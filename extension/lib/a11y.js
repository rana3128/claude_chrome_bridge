// Accessibility-tree compaction.
//
// The a11y tree is the default read mode because it is both smaller than the
// DOM and closer to meaning: roles and names are what a page is *for*, whereas
// most of the DOM is layout scaffolding. This module turns CDP's verbose
// AXNode list into indented text a model can actually reason over.

import { isSensitiveField, redactText } from './redact.js';

// Roles that carry no meaning of their own. Their children are lifted to the
// parent's level rather than being dropped.
const PRESENTATIONAL = new Set([
  'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'Ignored',
  'GenericContainer', 'group', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell',
  'DescriptionList', 'Legend', 'Pre', 'Time', 'Abbr', 'Emphasis', 'Strong', 'Canvas',
]);

// Roles whose presence is meaningful even with no accessible name.
const KEEP_UNNAMED = new Set([
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'spinbutton',
  'table', 'list', 'listbox', 'form', 'main', 'navigation', 'dialog', 'alert', 'img',
]);

// Roles the model can act on, worth carrying a ref for.
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'slider', 'spinbutton',
]);

const STATE_PROPS = ['checked', 'selected', 'expanded', 'disabled', 'required', 'invalid', 'pressed', 'focused'];

// Zero-width and directional marks are invisible to the user and pure noise to
// a model, but pages emit them constantly as layout hacks.
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\ufeff\u00ad]/g;

function clean(text) {
  return String(text ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function val(field) {
  if (!field) return undefined;
  const v = field.value;
  return v && typeof v === 'object' ? v.value : v;
}

function propMap(node) {
  const out = {};
  for (const p of node.properties || []) out[p.name] = val(p);
  return out;
}

/**
 * @param {Array} nodes raw AXNodes from Accessibility.getFullAXTree
 * @returns {{text: string, nodesKept: number, nodesDropped: number, truncated: boolean}}
 */
export function compactAxTree(nodes, { maxNodes = 1500, maxDepth = 25 } = {}) {
  const byId = new Map();
  for (const n of nodes || []) byId.set(n.nodeId, n);

  const roots = (nodes || []).filter((n) => !n.parentId || !byId.has(n.parentId));
  const lines = [];
  let kept = 0;
  let dropped = 0;
  let truncated = false;

  const walk = (node, depth, parentName = '') => {
    if (!node || truncated) return;
    if (kept >= maxNodes) { truncated = true; return; }

    const role = val(node.role) || 'unknown';
    const name = clean(val(node.name));
    const props = propMap(node);
    const ignored = node.ignored === true;
    // Collapse: presentational or unnamed-and-uninteresting nodes contribute
    // nothing, so their children take their place at this indent level.
    const collapse =
      ignored ||
      PRESENTATIONAL.has(role) ||
      (!name && !KEEP_UNNAMED.has(role) && role !== 'StaticText');

    if (collapse) {
      dropped++;
      for (const childId of node.childIds || []) walk(byId.get(childId), depth, parentName);
      return;
    }

    if (role === 'StaticText') {
      // A control's text usually *is* its accessible name, so emitting it again
      // as a child doubles the size of the output and adds nothing. Keep only
      // text that says something the parent did not.
      if (!name || name === parentName || parentName.includes(name)) {
        dropped++;
        return;
      }
      lines.push(`${'  '.repeat(Math.min(depth, maxDepth))}text "${redactText(name)}"`);
      kept++;
      return;
    }

    let value = val(node.value);
    if (typeof value === 'string') value = clean(value);
    if (value != null && value !== '') {
      value = isSensitiveField({ name, ariaLabel: name, type: props.roledescription })
        ? '[REDACTED]'
        : redactText(String(value));
    }

    const states = STATE_PROPS
      .filter((p) => props[p] !== undefined && props[p] !== false && props[p] !== 'false')
      .map((p) => (props[p] === true || props[p] === 'true' ? p : `${p}=${props[p]}`));

    const parts = [role];
    if (name) parts.push(`"${redactText(name).slice(0, 200)}"`);
    if (value != null && value !== '') parts.push(`value="${String(value).slice(0, 200)}"`);
    if (props.level) parts.push(`level=${props.level}`);
    if (states.length) parts.push(states.join(' '));
    if (INTERACTIVE.has(role) && node.backendDOMNodeId) parts.push(`ref=${node.backendDOMNodeId}`);

    lines.push(`${'  '.repeat(Math.min(depth, maxDepth))}${parts.join(' ')}`);
    kept++;

    for (const childId of node.childIds || []) walk(byId.get(childId), depth + 1, name);
  };

  for (const root of roots) walk(root, 0);

  if (truncated) {
    lines.push(
      `[TRUNCATED: the accessibility tree exceeded ${maxNodes} nodes. Use read_page(tabId, {mode:'a11y', ` +
      `selector:'…'}) to read one region, or query(tabId, selector) for specific elements.]`,
    );
  }

  return { text: lines.join('\n'), nodesKept: kept, nodesDropped: dropped, truncated };
}
