import assert from "node:assert/strict";
import test from "node:test";
import { yearToLatestLedgerRange } from "../src/lib/bond-ledger/weekly-report.ts";
import { segmentIntersectsRect, overlapArea } from "../src/label-placement.ts";
import { installDom } from "./helpers/svelte-dom.mjs";

test("新版默认本年初至最新持仓日，空年不回退，忽略未来日期", () => {
  assert.deepEqual(yearToLatestLedgerRange("2026-09-10", ["2026-09-04", "2026-09-09", "2026-09-07", "2026-09-11"]), {
    startDate: "2026-01-01", endDate: "2026-09-09",
  });
  assert.deepEqual(yearToLatestLedgerRange("2027-01-02", ["2026-12-31"]), {
    startDate: "2027-01-01", endDate: "2027-01-02",
  });
});

test("新版规模标记在容器缩放后避开曲线，质押只有最新点且无图例或引导线", async () => {
  const window = installDom();
  let resized;
  globalThis.ResizeObserver = class {
    constructor(callback) { resized = callback; }
    observe() {}
    unobserve() {}
  };
  window.matchMedia = () => ({ matches: true });
  const { renderWeeklyPoolScaleLeverage } = await import("../src/charts/bond-ledger.ts");
  const { seriesLineSegments, disposeChart } = await import("../src/charts/charting.ts");
  const { getInstanceByDom } = await import("echarts/core");
  const host = document.createElement("div");
  let width = 480;
  let height = 372;
  Object.defineProperties(host, {
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
  });
  document.body.append(host);
  const points = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    principal: (45 + Math.floor(index / 6) * 6) * 1e8,
    marketValue: (45 + index + Math.sin(index) * 2) * 1e8,
    timeWeightedPrincipal: (44 + index / 10) * 1e8,
    leverage: 1 + index / 300,
  }));
  try {
    renderWeeklyPoolScaleLeverage(host, points, 5_520_100_000, 1_879_644_000);
    const chart = getInstanceByDom(host);
    const option = chart.getOption();
    const annotations = option.series.find(series => series.id === "weekly-scale-annotations");
    assert.equal(annotations.type, "scatter");
    assert.equal(annotations.data.length, 2);
    assert.deepEqual(annotations.data[1].value, [points.at(-1).date, 55.201]);
    assert.equal(annotations.data[1].labelLine.show, false);
    assert.match(annotations.data[0].label.formatter, /已质押 55.20 亿\n可用 18.80 亿/);
    assert.deepEqual(option.legend.flatMap(legend => legend.data), ["业务本金", "全池持仓市值", "时间加权本金", "全池综合杠杆率", "平层基准（100%）"]);
    const locations = [];
    for (const size of [[480, 372], [320, 430], [720, 430]]) {
      [width, height] = size;
      resized([{ target: host }]);
      const series = chart.getModel().getSeriesByIndex(5);
      const label = series.getData().getItemGraphicEl(0).getSymbolPath().getTextContent();
      const rect = label.getBoundingRect().clone();
      rect.applyTransform(label.getComputedTransform());
      locations.push([rect.x, rect.y]);
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width, JSON.stringify(rect));
      assert.ok(rect.y >= 52 && rect.y + rect.height <= height * 0.61, JSON.stringify(rect));
      for (const [index, key, step] of [[0, "principal", "end"], [1, "marketValue"], [2, "timeWeightedPrincipal"]]) {
        const lines = seriesLineSegments(host, index, points.map(row => [row.date, row[key] / 1e8]), step);
        assert.ok(lines.length > 0);
        assert.equal(lines.some(line => segmentIntersectsRect(line, rect)), false, `label crosses ${key} at ${width}px: ${JSON.stringify(rect)}`);
      }
      const point = series.getData().getItemGraphicEl(0).getSymbolPath();
      assert.ok(point.getTextGuideLine(), "latest holding retains a connector to the current point");
      const pledgeLabel = series.getData().getItemGraphicEl(1).getSymbolPath().getTextContent();
      const pledgeRect = pledgeLabel.getBoundingRect().clone();
      pledgeRect.applyTransform(pledgeLabel.getComputedTransform());
      assert.equal(overlapArea(rect, pledgeRect), 0);
    }
    assert.notDeepEqual(locations[0], locations[1]);
    renderWeeklyPoolScaleLeverage(host, [points.at(-1)], 0, 6_000_000_000);
    assert.match(host.textContent, /已质押 0.00 亿/);
    renderWeeklyPoolScaleLeverage(host, points, null, null);
    const historical = chart.getOption().series.find(series => series.id === "weekly-scale-annotations");
    assert.equal(historical.data.length, 1);
    assert.match(historical.data[0].label.formatter, /已质押 —\n可用 —/);
  } finally {
    disposeChart(host);
    host.remove();
    await window.happyDOM.close();
  }
});
