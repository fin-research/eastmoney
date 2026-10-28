import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { scrollableRegion } from '../src/lib/scrollable-region.ts';

test('overflow regions support keyboard scrolling without hijacking child controls or adding idle tab stops', () => {
  const window = new Window();
  const node = window.document.createElement('div');
  const input = window.document.createElement('input');
  node.append(input);
  let width = 300, content = 300, resize, disconnected = false;
  Object.defineProperties(node, { clientWidth: { get: () => width }, scrollWidth: { get: () => content } });
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() { disconnected = true; } };
  try {
    const action = scrollableRegion(node);
    assert.equal(node.tabIndex, -1);
    content = 960; resize();
    assert.equal(node.tabIndex, 0);
    const key = (target, value, options = {}) => {
      const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
      target.dispatchEvent(event);
      return event;
    };
    assert.equal(key(node, 'ArrowRight').defaultPrevented, true);
    assert.ok(node.scrollLeft > 0);
    key(node, 'End'); assert.equal(node.scrollLeft, 660);
    key(node, 'Home'); assert.equal(node.scrollLeft, 0);
    assert.equal(key(input, 'ArrowRight').defaultPrevented, false);
    assert.equal(key(node, 'ArrowRight', { ctrlKey: true }).defaultPrevented, false);
    assert.equal(node.scrollLeft, 0);
    width = 1000; resize(); assert.equal(node.tabIndex, -1);
    action.destroy();
    assert.equal(disconnected, true);
    assert.equal(node.hasAttribute('tabindex'), false);
    assert.equal(key(node, 'End').defaultPrevented, false);
  } finally { globalThis.ResizeObserver = originalObserver; window.happyDOM.abort(); }
});
