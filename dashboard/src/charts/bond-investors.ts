import type { ChartOption } from './charting';
import { tooltip } from './common';
import { financingChartCommon, financingColors } from './financing-dashboard';
import { investorBondTypes, type InvestorCategorySummary } from '../lib/financing/bond-investors';

export function investorStructureOption(rows: InvestorCategorySummary[], metric: 'total' | 'outstanding'): ChartOption {
  return {
    ...financingChartCommon,
    legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 16 } },
    tooltip: { ...financingChartCommon.tooltip, extraCssText: tooltip.extraCssText, trigger: 'axis', valueFormatter: (value: number) => `${value.toFixed(2)}亿元` },
    grid: { left: 12, right: 24, top: 38, bottom: 70, containLabel: true },
    xAxis: { type: 'category', data: [...investorBondTypes], axisLabel: { fontSize: 16, interval: 0 } },
    yAxis: { type: 'value', name: '亿元', axisLabel: { fontSize: 16 }, splitLine: { lineStyle: { type: 'dashed' } } },
    series: rows.map((row, index) => ({ name: row.category, type: 'bar', stack: '投资金额', barMaxWidth: 66,
      itemStyle: { color: financingColors[index % financingColors.length] },
      data: investorBondTypes.map(type => row[metric][type]) }))
  };
}

export function investorRankingOption(rows: { name: string; total: number; outstanding: number }[]): ChartOption {
  return {
    ...financingChartCommon,
    legend: { top: 0, textStyle: { fontSize: 16 } },
    tooltip: { ...financingChartCommon.tooltip, extraCssText: tooltip.extraCssText, trigger: 'axis', valueFormatter: (value: number) => `${value.toFixed(2)}亿元` },
    grid: { left: 12, right: 90, top: 75, bottom: 20, containLabel: true },
    xAxis: { type: 'value', position: 'top', name: '亿元', axisLabel: { fontSize: 16 }, splitLine: { lineStyle: { type: 'dashed' } } },
    yAxis: { type: 'category', inverse: true, data: rows.map(row => row.name), axisLabel: { fontSize: 16, width: 176, overflow: 'break' } },
    series: (['total', 'outstanding'] as const).map((metric, index) => ({ name: index ? '存续规模' : '累计规模', type: 'bar', barMaxWidth: 16,
      itemStyle: { color: financingColors[index], borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', fontSize: 16, formatter: (p: { value: number }) => p.value.toFixed(2) },
      data: rows.map(row => row[metric]) }))
  };
}
