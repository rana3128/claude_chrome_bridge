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

test('text that merely repeats its parent name is dropped', () => {
  // A control's text usually *is* its accessible name; emitting both doubles
  // the output for nothing, which is most of what a real page produces.
  const nodes = [
    node('1', 'RootWebArea', 'Doc', { childIds: ['2', '4'] }),
    node('2', 'heading', 'Configurations', { parentId: '1', childIds: ['3'] }),
    node('3', 'StaticText', 'Configurations', { parentId: '2' }),
    node('4', 'button', 'Copy link to clipboard', { parentId: '1', childIds: ['5'], backendDOMNodeId: 4 }),
    node('5', 'StaticText', 'Copy link', { parentId: '4' }),
  ];
  const { text } = compactAxTree(nodes);
  assert.equal(text.split('\n').filter((l) => l.includes('Configurations')).length, 1);
  assert.equal(text.includes('text "Copy link"'), false, 'text contained by the parent name adds nothing');
});

test('text that adds something to its parent is kept', () => {
  const nodes = [
    node('1', 'RootWebArea', 'Doc', { childIds: ['2'] }),
    node('2', 'listitem', 'Config', { parentId: '1', childIds: ['3'] }),
    node('3', 'StaticText', 'Token will expire in 60 days', { parentId: '2' }),
  ];
  assert.match(compactAxTree(nodes).text, /text "Token will expire in 60 days"/);
});

test('zero-width and directional marks are stripped, not emitted as nodes', () => {
  const nodes = [
    node('1', 'RootWebArea', 'Doc', { childIds: ['2', '3'] }),
    node('2', 'StaticText', '​', { parentId: '1' }),
    node('3', 'button', 'Toggle group ​', { parentId: '1', backendDOMNodeId: 3 }),
  ];
  const { text } = compactAxTree(nodes);
  assert.equal(text.includes('​'), false, 'invisible characters should never reach the output');
  assert.match(text, /button "Toggle group" ref=3/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('text')).length, 0);
});
