import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseBestLabelPlacement,
  overlapArea,
  segmentIntersectsRect,
} from "../src/label-placement.ts";

const bounds = { x: 8, y: 8, width: 984, height: 584 };

test("靠近横轴的数据标签自动从下方切换到上方", () => {
  const axis = { x: 0, y: 540, width: 1000, height: 60 };
  const placement = chooseBestLabelPlacement({
    point: { x: 100, y: 520 },
    label: { width: 120, height: 58 },
    bounds,
    obstacles: [axis],
    preferred: "bottom",
  });

  assert.equal(placement.side, "top");
  assert.equal(overlapArea(placement, axis), 0);
});

test("右下角标签自动避开横轴上方图例并保持在画布内", () => {
  const legend = { x: 760, y: 500, width: 240, height: 40 };
  const placement = chooseBestLabelPlacement({
    point: { x: 940, y: 485 },
    label: { width: 130, height: 58 },
    bounds,
    obstacles: [legend],
    preferred: "bottom",
  });

  assert.equal(overlapArea(placement, legend), 0);
  assert.ok(placement.x >= bounds.x);
  assert.ok(placement.x + placement.width <= bounds.x + bounds.width);
  assert.ok(placement.y >= bounds.y);
});

test("右上角标签即使首选位置越界也会被钳制在画布内", () => {
  const placement = chooseBestLabelPlacement({
    point: { x: 980, y: 18 },
    label: { width: 130, height: 58 },
    bounds,
    obstacles: [],
    preferred: "top",
  });

  assert.ok(placement.x >= bounds.x);
  assert.ok(placement.x + placement.width <= bounds.x + bounds.width);
  assert.ok(placement.y >= bounds.y);
  assert.ok(placement.y + placement.height <= bounds.y + bounds.height);
});

test("密集点位会搜索更远的空白区域并保留标签间距", () => {
  const compactBounds = { x: 8, y: 8, width: 284, height: 164 };
  const first = chooseBestLabelPlacement({
    point: { x: 150, y: 90 },
    label: { width: 96, height: 44 },
    bounds: compactBounds,
    obstacles: [],
    preferred: "top",
  });
  const second = chooseBestLabelPlacement({
    point: { x: 152, y: 91 },
    label: { width: 96, height: 44 },
    bounds: compactBounds,
    obstacles: [first],
    preferred: "top",
    collisionPadding: 6,
  });

  assert.equal(overlapArea(first, second), 0);
  assert.ok(second.x >= compactBounds.x);
  assert.ok(second.x + second.width <= compactBounds.x + compactBounds.width);
  assert.ok(second.y >= compactBounds.y);
  assert.ok(second.y + second.height <= compactBounds.y + compactBounds.height);
});

test("数据标签会避开穿过首选位置的曲线线段", () => {
  const line = { x1: 70, y1: 78, x2: 230, y2: 78 };
  const placement = chooseBestLabelPlacement({
    point: { x: 150, y: 130 },
    label: { width: 96, height: 44 },
    bounds: { x: 8, y: 8, width: 284, height: 164 },
    obstacles: [],
    lineObstacles: [line],
    linePadding: 6,
    preferred: "top",
    gap: 8,
  });

  assert.equal(
    segmentIntersectsRect(line, {
      x: placement.x - 6,
      y: placement.y - 6,
      width: placement.width + 12,
      height: placement.height + 12,
    }),
    false,
  );
});
