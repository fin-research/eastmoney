export const MARKET_CALENDAR_QUERY = String.raw`
  query MarketCalendar($date: Date!) {
    tradingDays(date: $date, fields: "date,isTradingDay,previousTradingDate")
  }
`;

export const MARKET_SNAPSHOT_QUERY = String.raw`
  query MarketSnapshot(
    $date: Date!
    $omoStart: Date!
    $primaryStart: Date!
  ) {
    omo(
      startDate: $omoStart
      endDate: $date
      fields: "operationDate,operationName,duration,interestRate,operationAmount"
    )
    dr: cfets(
      date: $date
      source: "DR"
      fields: "bondCode,weightedYield,weightedYieldUpDownValueBp"
    )
    dibo: cfets(
      date: $date
      source: "DIBO"
      fields: "bondCode,weightedYield,weightedYieldUpDownValueBp"
    )
    governmentBonds: bondTopCase(
      date: $date
      fields: "ordinateName,abscissaName,bondCode,tradeNum,yield,yieldSubYtdCloseBp"
    )
    futures: futuresLatest(
      fields: "contractCode,lastPrice,upDownValuePct"
    )
    stock: stockSummary(
      date: $date
      fields: "title,time,paragraphs"
    )
    margin(
      date: $date
      fields: "DIM_DATE,TOTAL_RZRQYE,TOTAL_RZYE,TOTAL_RQYE"
    )
    industry(
      date: $date
      fields: "dataDate,equities,industries,turnoverYi,turnoverChangeYi"
    )
    primary: primaryIssues(
      date: $date
      startDate: $primaryStart
      fields: "bidStartDate,issueStartDate,biddingTime,comShortName,issuerShortName,issuerShortNameCn,comFullName,issuerName,publicOffering,publicOfferingText,offeringType,issueWay,raisingMode,bondTypeText,bondShortName,issueTenor,planIssueAmount,issueCouponRate"
    )
    todayTrades(
      limit: 300
      fields: "bondUniCode,remainingTenor,cbYte,tradeYield,tradeYieldSubCb"
    )
    favoriteQuotes(
      limit: 100
      fields: "bondUniCode,bondShortName,remainingTenor,remainingTenorDay,cbYield,bidYield,bidEntryPrice,ofrYield,ofrEntryPrice,tradeEntryPrice,tradeYieldSubCb"
    )
  }
`;

export const BOND_INFOS_QUERY = String.raw`
  query BondInfos($codes: String!) {
    bondInfos(
      codes: $codes
      fields: "bondUniCode,bondShortName,comShortName,bondType,bondOfferingType,sciTechInnoBondStatus"
    )
  }
`;

export function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function previousTradingDate(
  calendar: unknown,
  reportDate: string,
): string {
  if (!isRecord(calendar) || calendar.date !== reportDate || calendar.isTradingDay !== true
    || typeof calendar.previousTradingDate !== "string" || calendar.previousTradingDate >= reportDate) {
    throw new Error("GraphQL tradingDays did not confirm a previous trading date");
  }
  return calendar.previousTradingDate;
}

export function referencedBondCodes(
  todayTrades: unknown,
  favoriteQuotes: unknown,
): string[] {
  const rows = [todayTrades, favoriteQuotes]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isRecord);
  return [...new Set(rows
    .map((row) => String(row.bondUniCode ?? ""))
    .filter((code) => code && code !== "0"))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
