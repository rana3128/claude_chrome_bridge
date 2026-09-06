import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAxTree } from '../../extension/lib/a11y.js';

const node = (id, role, name, extra = {}) => ({
  nodeId: id,
  role: { type: 'role', value: role },
  name: { type: 'computedString', value: name },
  childIds: [],
  ...extra,
});

function tree() {
  return [
    node('1', 'RootWebArea', 'Account settings', { childIds: ['2'] }),
    node('2', 'generic', '', { childIds: ['3', '4', '7'], parentId: '1' }),
    node('3', 'heading', 'Account settings', { parentId: '2', properties: [{ name: 'level', value: { value: 1 } }] }),
    node('4', 'generic', '', { childIds: ['5', '6'], parentId: '2' }),
    node('5', 'textbox', 'Password', {
      parentId: '4', backendDOMNodeId: 55,
      value: { type: 'string', value: 'hunter2' },
      properties: [{ name: 'required', value: { value: true } }],
    }),
    node('6', 'button', 'Save', { parentId: '4', backendDOMNodeId: 66 }),
    node('7', 'presentation', '', { parentId: '2', childIds: ['8'] }),
    node('8', 'StaticText', 'Signed in as dev@example.test', { parentId: '7' }),
  ];
}

test('presentational wrappers are collapsed, meaningful nodes are kept', () => {
  const { text, nodesDropped } = compactAxTree(tree());
  const lines = text.split('\n');
  assert.equal(lines.some((l) => l.includes('generic')), false, 'generic wrappers should be dropped');
  assert.equal(lines.some((l) => l.includes('presentation')), false);
  assert.ok(nodesDropped >= 3, 'collapsed nodes should be counted');
  assert.match(text, /heading "Account settings" level=1/);
  assert.match(text, /button "Save"/);
});

test('collapsing lifts children rather than losing them', () => {
  const { text } = compactAxTree(tree());
  assert.match(text, /text "Signed in as dev@example\.test"/);
});

test('interactive nodes carry a ref that click and type accept', () => {
  const { text } = compactAxTree(tree());
  assert.match(text, /button "Save" ref=66/);
  assert.match(text, /textbox "Password".*ref=55/);
});

test('a field named as a password never carries its value through', () => {
  const { text } = compactAxTree(tree());
  assert.equal(text.includes('hunter2'), false);
  assert.match(text, /value="\[REDACTED\]"/);
});

test('states are rendered compactly', () => {
  const { text } = compactAxTree(tree());
  assert.match(text, /required/);
});

test('ignored nodes are skipped but their children survive', () => {
  const nodes = [
    node('1', 'RootWebArea', 'Doc', { childIds: ['2'] }),
    node('2', 'generic', 'hidden wrapper', { parentId: '1', ignored: true, childIds: ['3'] }),
    node('3', 'link', 'Continue', { parentId: '2', backendDOMNodeId: 3 }),
  ];
  const { text } = compactAxTree(nodes);
  assert.equal(text.includes('hidden wrapper'), false);
  assert.match(text, /link "Continue" ref=3/);
});

test('huge trees are cut at the node cap with an explicit marker', () => {
  const nodes = [node('root', 'RootWebArea', 'Big', { childIds: [] })];
  for (let i = 0; i < 500; i++) {
    nodes[0].childIds.push(`n${i}`);
    nodes.push(node(`n${i}`, 'link', `Item ${i}`, { parentId: 'root', backendDOMNodeId: i }));
  }
  const { text, truncated } = compactAxTree(nodes, { maxNodes: 50 });
  assert.equal(truncated, true);
  assert.match(text, /TRUNCATED: the accessibility tree exceeded 50 nodes/);
  assert.match(text, /read_page\(tabId, \{mode:'a11y', selector:'…'\}\)/);
  assert.ok(text.split('\n').length < 60);
});

test('indentation reflects the surviving hierarchy', () => {
  const { text } = compactAxTree(tree());
  const heading = text.split('\n').find((l) => l.includes('heading'));
  assert.match(heading, /^ {2}heading/, 'children of the root sit one level in');
});

test('an empty tree produces empty output rather than throwing', () => {
  assert.deepEqual(compactAxTree([]), { text: '', nodesKept: 0, nodesDropped: 0, truncated: false });
  assert.doesNotThrow(() => compactAxTree(undefined));
});
