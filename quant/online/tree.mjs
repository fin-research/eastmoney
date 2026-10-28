// Portable LightGBM regression trees and exact path-dependent Shapley values.
// No runtime, Node builtins or dynamic code compilation: Worker/browser compatible.
export function goesLeft(node, x) {
  let value = x[node.split_feature];
  if (node.decision_type === "==") {
    if (value == null || !Number.isFinite(value) || value < 0) return false;
    return String(node.threshold).split("||").map(Number).includes(Math.trunc(value));
  }
  const missing = value == null || Number.isNaN(value);
  if (missing && node.missing_type === "NaN") return node.default_left;
  // LightGBM treats NaN as zero if the split was trained without NaN routing.
  if (missing) value = 0;
  if (node.missing_type === "Zero" && value === 0) return node.default_left;
  if (node.decision_type !== "<=")
    throw new Error("Unsupported categorical tree");
  return value <= node.threshold;
}

export function predict(model, x) {
  let result = 0;
  for (const tree of model.trees) {
    let node = tree;
    while (node.split_feature !== undefined)
      node = goesLeft(node, x) ? node.left_child : node.right_child;
    result += node.leaf_value;
  }
  return result;
}

// Each leaf contributes v(S)=leaf * product(hot if observed else cover fraction).
// Dummy-feature invariance reduces the Shapley integral to the <=6 distinct
// features on that leaf path; repeated splits on a feature are combined first.
function addLeaf(value, path, phi) {
  const entries = [...path.entries()];
  for (let j = 0; j < entries.length; j++) {
    const [feature, { hot, zero }] = entries[j];
    let poly = [1];
    for (let k = 0; k < entries.length; k++) {
      if (j === k) continue;
      const other = entries[k][1];
      const next = new Array(poly.length + 1).fill(0);
      for (let n = 0; n < poly.length; n++) {
        next[n] += poly[n] * other.zero;
        next[n + 1] += poly[n] * (other.hot - other.zero);
      }
      poly = next;
    }
    const integral = poly.reduce(
      (sum, coefficient, n) => sum + coefficient / (n + 1),
      0,
    );
    phi[feature] += value * (hot - zero) * integral;
  }
}

export function explain(model, x) {
  const phi = new Array(x.length).fill(0);
  let expected = 0;
  function visit(node, path, probability) {
    if (node.split_feature === undefined) {
      expected += probability * node.leaf_value;
      addLeaf(node.leaf_value, path, phi);
      return;
    }
    const leftHot = goesLeft(node, x);
    const count = node.internal_count;
    for (const [child, hot] of [
      [node.left_child, leftHot],
      [node.right_child, !leftHot],
    ]) {
      const fraction = (child.internal_count ?? child.leaf_count) / count;
      const next = new Map(path);
      const previous = next.get(node.split_feature) ?? { hot: 1, zero: 1 };
      next.set(node.split_feature, {
        hot: previous.hot * Number(hot),
        zero: previous.zero * fraction,
      });
      visit(child, next, probability * fraction);
    }
  }
  for (const tree of model.trees) visit(tree, new Map(), 1);
  return { values: phi, expected };
}
