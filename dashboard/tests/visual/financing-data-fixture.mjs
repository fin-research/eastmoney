export const financialMonths = [
  {period_end:'2026-07-31',net_capital:824.7991,securities_net_assets:null,group_net_assets:null,total_assets:4636.3417,total_liabilities:3811.2716,agency_brokerage_funds:1723.6268,asset_liability_ratio:.822,adjusted_asset_liability_ratio:.7167,notes:'来源：月度财务报表',updated_at:'2026-08-01T00:00:00Z'},
  {period_end:'2025-12-31',net_capital:800,securities_net_assets:820,group_net_assets:1000,total_assets:4500,total_liabilities:3680,agency_brokerage_funds:1600,asset_liability_ratio:3680/4500,adjusted_asset_liability_ratio:2080/2900,notes:'来源：年度财务报表',updated_at:'2026-01-01T00:00:00Z'},
];
export async function mockFinancialMonths(page){
  await page.route('**/financing/data/token',route=>route.fulfill({json:{token:'visual-fixture',dataApiUrl:'https://financial-fixture.invalid'}}));
  await page.route('https://financial-fixture.invalid/**',route=>route.request().method()==='GET'
    ?route.fulfill({json:financialMonths})
    :route.fulfill({status:405,json:{message:'只读视觉夹具'}}));
}
