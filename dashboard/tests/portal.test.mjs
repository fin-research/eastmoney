import test from "node:test";
import assert from "node:assert/strict";

import { portal } from "../src/lib/portal.ts";

class FakeNode {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] ?? null;
  }

  before(node) {
    this.parentNode?.insertBefore(node, this);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }
}

class FakeParent extends FakeNode {
  constructor(name) {
    super(name);
    this.children = [];
  }

  append(node) {
    this.insertBefore(node, null);
  }

  insertBefore(node, reference) {
    node.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}

test("portal 在视图销毁后清理 header action，重新挂载不会叠加", () => {
  const target = new FakeParent("header-actions");
  const previousDocument = globalThis.document;
  globalThis.document = {
    createComment: () => new FakeNode("anchor"),
    querySelector: (selector) => (selector === "#actions" ? target : null),
  };

  try {
    const firstOrigin = new FakeParent("first-origin");
    const firstActions = new FakeNode("first-actions");
    firstOrigin.append(firstActions);
    const firstPortal = portal(firstActions, "#actions");

    assert.deepEqual(target.children, [firstActions]);
    firstPortal.destroy();
    assert.deepEqual(target.children, []);
    assert.deepEqual(firstOrigin.children, []);

    const secondOrigin = new FakeParent("second-origin");
    const secondActions = new FakeNode("second-actions");
    secondOrigin.append(secondActions);
    const secondPortal = portal(secondActions, "#actions");

    assert.deepEqual(target.children, [secondActions]);
    secondPortal.update(null);
    assert.equal(secondActions.parentNode, secondOrigin);
    secondPortal.destroy();
  } finally {
    globalThis.document = previousDocument;
  }
});
