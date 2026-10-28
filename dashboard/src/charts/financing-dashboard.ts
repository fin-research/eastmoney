import type { ChartOption } from './charting';

export const financingColors = ['#2f6fed', '#16a394', '#6941c6', '#f79009', '#d92d20', '#0ba5ec', '#6172f3', '#12b76a'];
const colors = financingColors;
export const financingChartCommon = {
  color: colors,
  animationDuration: 260,
  animationDurationUpdate: 180,
  aria: { enabled: true, decal: { show: false } },
  textStyle: { fontFamily: 'system-ui, sans-serif', fontSize: 16 },
  tooltip: { confine: true, textStyle: { fontSize: 16 } },
};
const common = financingChartCommon;

export function financingCompositionOption(rows: Array<{ type: string; amountYi: number }>, compactLabels = false): ChartOption {
  return {
    ...common,
    tooltip: { ...common.tooltip, trigger: 'item', valueFormatter: (value: number) => `${value.toFixed(2)}亿元` },
    legend: { type: compactLabels ? 'plain' : 'scroll', bottom: 0, left: compactLabels ? 8 : undefined, right: compactLabels ? 8 : undefined, textStyle: { fontSize: 16 } },
    series: [{ type: 'pie', radius: compactLabels ? ['30%', '52%'] : ['38%', '65%'], center: ['50%', compactLabels ? '40%' : '44%'],
      label: { formatter: '{b}\n{d}%', fontSize: 16, overflow: compactLabels ? 'none' : 'break', ...(compactLabels ? { alignTo: 'edge', edgeDistance: 8 } : {}) },
      data: rows.filter(row => !compactLabels || row.amountYi > 0).map(row => ({ name: row.type, value: row.amountYi })) }],
  };
}

export function financingMaturityOption(rows: Array<{ month: string; amountYi: number }>): ChartOption {
  const max = Math.max(0, ...rows.map(row => row.amountYi));
  return {
    ...common,
    grid: { left: 12, right: 12, top: 35, bottom: 40, containLabel: true },
    legend: { bottom: 0, textStyle: { fontSize: 16 } },
    tooltip: { ...common.tooltip, trigger: 'axis', valueFormatter: (value: number) => `${value.toFixed(2)}亿元` },
    xAxis: { type: 'category', data: rows.map(row => `${Number(row.month.slice(5, 7))}月`), axisLabel: { fontSize: 16 } },
    yAxis: { type: 'value', name: '亿元', axisLabel: { fontSize: 16 }, splitLine: { lineStyle: { type: 'dashed' } } },
    series: [{ name: '到期本金', type: 'bar', barMaxWidth: 48,
      label: { show: true, position: 'top', fontSize: 16, formatter: (p: { value: number }) => p.value.toFixed(1) },
      data: rows.map(row => ({ value: row.amountYi, itemStyle: { color: row.amountYi === max && max > 0 ? colors[4] : colors[0], borderRadius: [4, 4, 0, 0] } })) }],
  };
}
