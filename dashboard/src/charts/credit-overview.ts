import { setChart } from './charting';
import { workbenchBarChartOption } from './trading-research';
import { financingCompositionOption } from './financing-dashboard';
import { tooltip, escapeHtml, axisLabel, colors } from './common';
import type { CreditChartDatum } from '../lib/credit/overview.ts';

export function renderCreditOverviewBarChart(host: HTMLElement, data: readonly CreditChartDatum[], description: string, unit: string): void {
  const option = workbenchBarChartOption(data, description, unit);
  option.yAxis = { ...(option.yAxis as object), axisLabel: { ...axisLabel, color: colors.ink, width: host.clientWidth < 420 ? 96 : 160, overflow: 'truncate' } };
  if (data.some(row => row.registeredCount != null)) {
    option.tooltip = { ...tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (params: { dataIndex: number } | Array<{ dataIndex: number }>) => {
        const row = data[(Array.isArray(params) ? params[0] : params)!.dataIndex]!;
        const amount = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)}亿元`;
        const lines = [escapeHtml(row.label), `${description}：${row.value == null ? '—' : `${row.value.toFixed(1)}${unit}`}`,
          `已登记：${row.registeredCount}家`, `未登记：${row.unregisteredCount}家`];
        if (unit === '%') lines.push(`额度：${amount(row.registeredLimit)}`, `已用：${amount(row.registeredUsed)}`);
        if (row.unregisteredCount && row.unregisteredUsed != null && row.unregisteredUsed !== 0) {
          lines.push(`未登记额度已用：${amount(row.unregisteredUsed)}`);
        }
        return lines.join('<br>');
      } };
  }
  setChart(host, option);
}

export function renderCreditOverviewDonutChart(host: HTMLElement, data: readonly CreditChartDatum[], description: string): void {
  const option = financingCompositionOption(data.map(row => ({ type: row.label, amountYi: row.value ?? 0 })), host.clientWidth < 420);
  setChart(host, { ...option, legend: data.filter(row => (row.value ?? 0) > 0).length > 1 ? option.legend : { show: false }, aria: { enabled: true, description },
    tooltip: { ...tooltip, trigger: 'item', valueFormatter: (value: unknown) => `${value}家` } });
}

export function renderCreditOverviewHistogram(host: HTMLElement, data: readonly CreditChartDatum[], description: string): void {
  const option = workbenchBarChartOption(data, description, '家');
  const series = (option.series as Array<Record<string, unknown>>)[0]!;
  setChart(host, { ...option,
    grid: { left: 8, right: 16, top: 28, bottom: 12, containLabel: true },
    xAxis: { ...(option.yAxis as object), inverse: false, data: data.map(row => row.label),
      axisLabel: { ...axisLabel, interval: 0, formatter: (label: string) => {
        if (host.clientWidth >= 420) return label;
        return label === '无到期日' ? '无到\n期日' : label.includes('–') ? label.replace('–', '–\n') : label.replace('日', '日\n');
      } } },
    yAxis: { ...(option.xAxis as object), nameGap: 12 },
    series: [{ ...series, barMaxWidth: undefined, barCategoryGap: '0%', showBackground: false,
      label: { ...(series.label as object), position: 'top' },
      data: (series.data as Array<{ value: number | null; itemStyle: object }>).map(row => ({ ...row, itemStyle: { ...row.itemStyle, borderRadius: [4, 4, 0, 0] } })) }],
  });
}

export function renderCreditOverviewGauge(host: HTMLElement, utilization: number, totalLimit: number, totalUsed: number): void {
  setChart(host, {
    animationDuration: 180,
    aria: { enabled: true, description: `授信额度使用率${utilization.toFixed(1)}%` },
    tooltip: { ...tooltip, formatter: `使用率：${utilization.toFixed(1)}%<br>额度：${totalLimit.toFixed(2)}亿元<br>已用：${totalUsed.toFixed(2)}亿元` },
    series: [{ type: 'gauge', min: Math.min(0, utilization), max: Math.max(100, utilization),
      startAngle: 205, endAngle: -25, radius: '82%', center: ['50%', '57%'],
      progress: { show: true, width: 12, itemStyle: { color: '#2f6fed' } },
      axisLine: { lineStyle: { width: 12, color: [[1, colors.brandSoft]] } },
      pointer: { length: '62%', width: 4, itemStyle: { color: colors.ink } },
      anchor: { show: true, size: 9, itemStyle: { color: colors.paper, borderColor: colors.ink, borderWidth: 3 } },
      axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { ...axisLabel, distance: 20, formatter: (value: number) => `${value}` },
      title: { show: false },
      detail: { offsetCenter: [0, '62%'], color: colors.ink, fontSize: 24, fontWeight: 'bolder', formatter: (value: number) => `${value.toFixed(1)}%` },
      data: [{ value: utilization }],
    }],
  });
}
