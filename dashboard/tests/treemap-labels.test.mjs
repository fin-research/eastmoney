import assert from "node:assert/strict";
import test from "node:test";

import {
  fitTreemapLabel,
  formatTreemapLabel,
} from "../src/treemap-labels.ts";

test("较大行业矩形显示行业名和涨跌幅", () => {
  assert.equal(formatTreemapLabel("电子", "−7.02%"), "电子\n−7.02%");
});

test("所有热力图标签都同时包含行业名和涨跌幅", () => {
  assert.equal(
    formatTreemapLabel("美容护理", "+0.18%"),
    "美容护理\n+0.18%",
  );
});

test("标签字号自适应且不低于 8px", () => {
  const layout = fitTreemapLabel("美容护理\n+0.18%", { width: 90, height: 40 }, 16);

  assert.equal(layout.visible, true);
  assert.ok(layout.fontSize >= 8);
  assert.ok(layout.fontSize < 16);
  assert.equal(layout.width, 84);
  assert.equal(layout.height, 36);
});

test("横向小矩形仍显示两行行业信息", () => {
  const layout = fitTreemapLabel("美容护理\n+0.18%", { width: 56, height: 30 }, 16);

  assert.equal(layout.visible, true);
  assert.ok(layout.fontSize >= 8);
});

test("不足以同时容纳两行 8px 标签时整体隐藏", () => {
  assert.deepEqual(
    fitTreemapLabel("美容护理\n+0.18%", { width: 24, height: 18 }, 16),
    {
      visible: false,
      fontSize: 0,
      lineHeight: 0,
      width: 0,
      height: 0,
    },
  );
});
