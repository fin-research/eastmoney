<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import ChartHost from "../../components/ChartHost.svelte";
  import MetricCard from "../../components/MetricCard.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import {
    renderWorkbenchBarChart,
    renderWorkbenchStackedBarChart,
  } from "../../charts/trading-research";
  import Badge from "./Badge.svelte";
  import PanelHeading from "./PanelHeading.svelte";
  import SectionHeading from "./SectionHeading.svelte";
  import WorkbenchIcon from "./WorkbenchIcon.svelte";
  import {
    demoTrades,
    tradeVolumeHistory,
    tradingSummary,
  } from "./demo-data";

  type TradeSort = "time-asc" | "time-desc" | "amount-desc" | "rate-asc";
  type ParsedTicket = {
    direction: string;
    product: string;
    amount: string;
    term: string;
    rate: string;
    counterparty: string;
    collateral: string;
    risk: string;
  };

  let query = $state("");
  let product = $state("all");
  let direction = $state("all");
  let status = $state("all");
  let sort = $state<TradeSort>("time-asc");
  let tradeText = $state("");
  let parsedTicket = $state<ParsedTicket | null>(null);
  let parserMessage = $state("等待解析");
  let ticketConfirmed = $state(false);

  const filteredTrades = $derived.by(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return demoTrades
      .filter((trade) => {
        const matchesQuery =
          !normalizedQuery ||
          [
            trade.id,
            trade.counterparty,
            trade.product,
            trade.term,
            trade.collateral,
          ]
            .join(" ")
            .toLocaleLowerCase("zh-CN")
            .includes(normalizedQuery);
        const matchesProduct = product === "all" || trade.product === product;
        const matchesDirection =
          direction === "all" || trade.direction === direction;
        const matchesStatus = status === "all" || trade.status === status;
        return (
          matchesQuery &&
          matchesProduct &&
          matchesDirection &&
          matchesStatus
        );
      })
      .sort((left, right) => {
        if (sort === "time-desc") return right.time.localeCompare(left.time);
        if (sort === "amount-desc") return right.amount - left.amount;
        if (sort === "rate-asc") return left.rate - right.rate;
        return left.time.localeCompare(right.time);
      });
  });

  const counterparties = Array.from(
    demoTrades.reduce((totals, trade) => {
      totals.set(
        trade.counterparty,
        (totals.get(trade.counterparty) ?? 0) + trade.amount,
      );
      return totals;
    }, new Map<string, number>()),
  )
    .map(([label, amount]) => ({
      label,
      amount,
      share: (amount / tradingSummary.totalAmount) * 100,
    }))
    .sort((left, right) => right.amount - left.amount);

  const concentrationBars = counterparties.slice(0, 8).map((row) => ({
    label: row.label,
    value: row.share,
    color: "#2f6fed",
  }));
  const concentrationSummary = {
    top1: counterparties[0]?.share ?? 0,
    top3: counterparties
      .slice(0, 3)
      .reduce((sum, counterparty) => sum + counterparty.share, 0),
    hhi: counterparties.reduce(
      (sum, counterparty) => sum + Math.pow(counterparty.share / 100, 2),
      0,
    ),
  };

  function productLabel(productName: string): string {
    return productName === "同业拆借"
      ? "同业拆借（纯信用）"
      : "拆出（质押式回购）";
  }

  function exportTrades(): void {
    const header = [
      "交易编号",
      "时间",
      "方向",
      "业务类型",
      "交易对手",
      "金额（亿元）",
      "期限",
      "利率",
      "质押券",
      "押券风控",
      "状态",
    ];
    const rows = filteredTrades.map((trade) => [
      trade.id,
      trade.time,
      trade.direction,
      productLabel(trade.product),
      trade.counterparty,
      trade.amount,
      trade.term,
      `${trade.rate.toFixed(2)}%`,
      trade.collateral,
      trade.collateralRisk,
      trade.status,
    ]);
    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "交易记录.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function parseTradeText(): void {
    const text = tradeText.trim();
    ticketConfirmed = false;
    if (!text) {
      parsedTicket = null;
      parserMessage = "请先粘贴交易聊天记录";
      return;
    }

    const directionMatch = text.match(/融入|融出/);
    const productMatch = text.match(/同业拆借|质押式回购|回购/);
    const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:亿元|亿)/);
    const termMatch = text.match(/隔夜|\d+\s*(?:D|M|Y|天|个月|年)/i);
    const rateMatch = text.match(/(?:利率)?\s*(\d+(?:\.\d+)?)\s*%/);
    const counterparty = Array.from(
      new Set(demoTrades.map((trade) => trade.counterparty)),
    ).find((name) => text.includes(name));
    const collateralMatch = text.match(
      /国债|政金债|地方债|信用债|城投债|利率债/,
    );
    const parsedProduct = productMatch?.[0]?.includes("回购")
      ? "质押式回购"
      : productMatch?.[0] ?? "待识别";

    parsedTicket = {
      direction: directionMatch?.[0] ?? "待识别",
      product: parsedProduct,
      amount: amountMatch ? `${amountMatch[1]}亿元` : "待识别",
      term: termMatch?.[0] ?? "待识别",
      rate: rateMatch ? `${rateMatch[1]}%` : "待识别",
      counterparty: counterparty ?? "待识别",
      collateral: collateralMatch?.[0] ?? (parsedProduct === "质押式回购" ? "待补录" : "不适用"),
      risk: parsedProduct === "质押式回购" ? "待补录并复核" : "不适用",
    };
    const pendingCount = Object.values(parsedTicket).filter(
      (value) => value === "待识别" || value === "待补录",
    ).length;
    parserMessage = pendingCount
      ? `已提取，仍有${pendingCount}项待补充`
      : "已提取全部基础要素";
  }
</script>

<div class="tr-view-stack">
  <section aria-labelledby="trading-metrics-title">
    <SectionHeading id="trading-metrics-title" title="当日交易概况" />
    <div class="tr-metric-grid tr-metric-grid--five">
      <MetricCard
        label="当日交易笔数"
        value={String(tradingSummary.tradeCount)}
        unit="笔"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "trading" }}
        tone="orange"
      />
      <MetricCard
        label="同业拆借"
        value={tradingSummary.interbankAmount.toFixed(1)}
        unit="亿元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "funds" }}
        tone="blue"
      />
      <MetricCard
        label="质押回购拆出"
        value={tradingSummary.repoLendAmount.toFixed(1)}
        unit="亿元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "credit" }}
        tone="purple"
      />
      <MetricCard
        label="纯信用占比"
        value={tradingSummary.interbankShare.toFixed(1)}
        unit="%"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "research" }}
        tone="green"
      />
      <MetricCard
        label="待确认"
        value={String(tradingSummary.pendingCount)}
        unit="笔"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "warning" }}
        tone="red"
      />
    </div>
  </section>

  <ModuleCard labelledBy="trade-table-title">
    <PanelHeading id="trade-table-title" title="实时交易记录" wrap>
      <div class="tr-table-controls tr-table-controls--trading" role="search">
        <label class="tr-search-control">
          <span class="sr-only">搜索交易</span>
          <WorkbenchIcon name="search" />
          <Input data-ui-owner="lib-trading-research-TradingView-svelte" class={"ui-input"} bind:value={query} type="search" />
        </label>
        <label>
          <span class="sr-only">业务品种</span>
          <NativeSelect data-ui-owner="lib-trading-research-TradingView-svelte" class={"ui-select"} bind:value={product}>
            <option value="all">全部业务</option>
            <option value="同业拆借">同业拆借</option>
            <option value="质押式回购">质押式回购</option>
          </NativeSelect>
        </label>
        <label>
          <span class="sr-only">交易方向</span>
          <NativeSelect data-ui-owner="lib-trading-research-TradingView-svelte" class={"ui-select"} bind:value={direction}>
            <option value="all">全部方向</option>
            <option value="融入">融入</option>
            <option value="融出">融出</option>
          </NativeSelect>
        </label>
        <label>
          <span class="sr-only">交易状态</span>
          <NativeSelect data-ui-owner="lib-trading-research-TradingView-svelte" class={"ui-select"} bind:value={status}>
            <option value="all">全部状态</option>
            <option value="已成交">已成交</option>
            <option value="待确认">待确认</option>
          </NativeSelect>
        </label>
        <label>
          <span class="sr-only">交易排序</span>
          <NativeSelect data-ui-owner="lib-trading-research-TradingView-svelte" class={"ui-select"} bind:value={sort}>
            <option value="time-asc">时间正序</option>
            <option value="time-desc">时间倒序</option>
            <option value="amount-desc">金额从高到低</option>
            <option value="rate-asc">利率从低到高</option>
          </NativeSelect>
        </label>
        <Button data-ui-owner="lib-trading-research-TradingView-svelte" variant="outline" class={"ui-button tr-table-action"} type="button" onclick={exportTrades}>导出当前结果</Button>
        <span class="tr-result-count">共 {filteredTrades.length} 笔</span>
      </div>
    </PanelHeading>
    <div class="tr-table-scroll" role="region" aria-label="交易记录" tabindex="0">
      <table class="ui-table tr-data-table tr-trade-table">
        <caption class="sr-only">交易研究工作台交易记录</caption>
        <thead>
          <tr><th>交易编号</th><th>时间</th><th>方向</th><th>业务类型</th><th>交易对手</th><th class="is-numeric">金额（亿元）</th><th>期限</th><th class="is-numeric">利率</th><th>质押券</th><th>押券风控</th><th>状态</th></tr>
        </thead>
        <tbody>
          {#each filteredTrades as trade (trade.id)}
            <tr>
              <th scope="row">{trade.id}</th>
              <td>{trade.time}</td>
              <td><span class={`tr-direction tr-direction--${trade.direction === "融出" ? "out" : "in"}`}>{trade.direction}</span></td>
              <td>{productLabel(trade.product)}</td>
              <td>{trade.counterparty}</td>
              <td class="is-numeric">{trade.amount.toFixed(1)}</td>
              <td>{trade.term}</td>
              <td class="is-numeric">{trade.rate.toFixed(2)}%</td>
              <td>{trade.collateral}</td>
              <td><Badge tone={trade.collateralRisk === "不适用" ? "neutral" : "warning"}>{trade.collateralRisk}</Badge></td>
              <td><Badge tone={trade.status === "待确认" ? "warning" : "success"}>{trade.status}</Badge></td>
            </tr>
          {:else}
            <tr><td class="tr-empty-cell" colspan="11">没有符合当前筛选条件的交易记录</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </ModuleCard>

  <div class="tr-two-column tr-two-column--trading">
    <ModuleCard labelledBy="trade-volume-title">
      <PanelHeading id="trade-volume-title" title="近15日两类业务成交趋势">
        <Badge>亿元</Badge>
      </PanelHeading>
      <ChartHost
        renderer={renderWorkbenchStackedBarChart}
        args={[tradeVolumeHistory, "近15日同业拆借与质押式回购拆出成交趋势", "亿元"]}
        ariaLabel="近15日同业拆借与质押式回购拆出成交趋势图"
        className="tr-chart-host"
      />
    </ModuleCard>

    <ModuleCard labelledBy="counterparty-title">
      <PanelHeading id="counterparty-title" title="交易对手集中度排名">
        <Badge tone="warning">30%单一对手关注线</Badge>
      </PanelHeading>
      <ChartHost
        renderer={renderWorkbenchBarChart}
        args={[concentrationBars, "当日交易对手成交金额占比排名", "%", 40, [30]]}
        ariaLabel="当日交易对手成交金额占比排名及30%关注线"
        className="tr-chart-host"
      />
      <div class="tr-concentration-stats" aria-label="交易对手集中度摘要">
        <div><span>Top 1</span><strong>{concentrationSummary.top1.toFixed(1)}%</strong></div>
        <div><span>Top 3</span><strong>{concentrationSummary.top3.toFixed(1)}%</strong></div>
        <div><span>HHI</span><strong>{concentrationSummary.hhi.toFixed(4)}</strong></div>
      </div>
    </ModuleCard>
  </div>

  <ModuleCard labelledBy="trade-parser-title">
    <PanelHeading id="trade-parser-title" title="交易解析">
      <Badge>规则辅助提取</Badge>
    </PanelHeading>
    <div class="tr-parser-grid">
      <div class="tr-parser-input">
        <label for="trade-parser-input">交易聊天记录</label>
        <Textarea data-ui-owner="lib-trading-research-TradingView-svelte" class={"ui-textarea"}
          id="trade-parser-input"
          bind:value={tradeText}
          rows={8}
        ></Textarea>
        <Button data-ui-owner="lib-trading-research-TradingView-svelte" variant="default" class={"ui-button  tr-primary-action"} type="button" onclick={parseTradeText}>规则解析</Button>
        <aside class="tr-collateral-checklist" aria-label="押券检查项">
          <strong>押券检查项</strong>
          <span>券种准入、评级与期限、折算率、估值覆盖、发行人集中度</span>
        </aside>
      </div>
      <div class="tr-parser-result" aria-live="polite">
        <div class="tr-parser-result__head">
          <strong>识别结果</strong>
          <Badge tone={parsedTicket ? "info" : "neutral"}>{parserMessage}</Badge>
        </div>
        {#if parsedTicket}
          <dl class="tr-entity-grid">
            <div><dt>方向</dt><dd>{parsedTicket.direction}</dd></div>
            <div><dt>品种</dt><dd>{parsedTicket.product}</dd></div>
            <div><dt>金额</dt><dd>{parsedTicket.amount}</dd></div>
            <div><dt>期限</dt><dd>{parsedTicket.term}</dd></div>
            <div><dt>利率</dt><dd>{parsedTicket.rate}</dd></div>
            <div><dt>交易对手</dt><dd>{parsedTicket.counterparty}</dd></div>
            <div><dt>质押券</dt><dd>{parsedTicket.collateral}</dd></div>
            <div><dt>押券风控</dt><dd>{parsedTicket.risk}</dd></div>
          </dl>
          <div class="tr-ticket-draft">
            <strong>交易凭证草稿</strong>
            <p>{parsedTicket.direction} · {parsedTicket.product} · {parsedTicket.amount} · {parsedTicket.term} · {parsedTicket.rate} · {parsedTicket.counterparty}</p>
          </div>
          <Button data-ui-owner="lib-trading-research-TradingView-svelte" variant="outline"
            class={"ui-button tr-secondary-action"}
            type="button"
            onclick={() => (ticketConfirmed = true)}
          >{ticketConfirmed ? "已确认解析结果" : "确认解析结果"}</Button>
        {:else}
          <div class="tr-parser-empty">解析后将在此展示交易要素与凭证草稿</div>
        {/if}
      </div>
    </div>
  </ModuleCard>
</div>
