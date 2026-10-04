import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTopmostDrawer } from '../src/renderer/components/ui/overlayEscape.ts';

function scene(styles) {
  let higherLayer = null;
  const document = {
    querySelector: (selector) =>
      higherLayer && selector.split(', ').includes(higherLayer) ? {} : null,
    querySelectorAll: () => panels,
    defaultView: { getComputedStyle: (node) => node.style },
  };
  const panels = styles.map((style) => ({
    ownerDocument: document,
    style: { visibility: 'visible', display: 'flex', zIndex: '1410', ...style },
  }));
  return {
    panels,
    document,
    cover: (selector = '.dialog-content') => (higherLayer = selector),
    uncover: () => (higherLayer = null),
  };
}

test('equal z-index drawers dismiss only the last painted panel', () => {
  const s = scene([{}, {}, {}]);
  assert.equal(isTopmostDrawer(s.panels[0]), false);
  assert.equal(isTopmostDrawer(s.panels[1]), false);
  assert.equal(isTopmostDrawer(s.panels[2]), true);
});

test('explicit stacking order wins over DOM order and hidden panels do not intercept Escape', () => {
  const s = scene([
    { zIndex: '1450' },
    {},
    { zIndex: '1490', visibility: 'hidden' },
    { zIndex: '1500', display: 'none' },
  ]);
  assert.equal(isTopmostDrawer(s.panels[0]), true);
  assert.equal(isTopmostDrawer(s.panels[1]), false);
  s.panels[0].style.visibility = 'hidden';
  assert.equal(isTopmostDrawer(s.panels[1]), true);
});

test('a closing layer blocks underlying drawers until its visibility transition finishes', () => {
  const s = scene([{}, {}]);
  s.panels[1].dataset = { state: 'closed' };
  assert.equal(isTopmostDrawer(s.panels[0]), false);
  s.panels[1].style.visibility = 'hidden';
  assert.equal(isTopmostDrawer(s.panels[0]), true);
});

test('Dialog and Popover Presence own Escape throughout their exit animation', () => {
  const s = scene([{}]);
  s.cover();
  assert.equal(isTopmostDrawer(s.panels[0]), false);
  s.uncover();
  assert.equal(isTopmostDrawer(s.panels[0]), true);
});

test('unmounted or unavailable drawer panels cannot dismiss', () => {
  assert.equal(isTopmostDrawer(null), false);
  const s = scene([{}]);
  assert.equal(isTopmostDrawer({ ownerDocument: s.document }), false);
  s.document.defaultView = null;
  assert.equal(isTopmostDrawer(s.panels[0]), false);
});

test('DatePicker Presence blocks a background Drawer before Escape reaches the calendar', () => {
  const s = scene([{}]);
  s.cover('.echo-date-picker-content');
  assert.equal(isTopmostDrawer(s.panels[0]), false);
  s.uncover();
  assert.equal(isTopmostDrawer(s.panels[0]), true);
});
