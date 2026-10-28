<script lang="ts">
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import InvestorsPage from '../../../src/routes/financing/bond-investors/+page.svelte';
  import { emptyInvestorAmounts, investorCategories, type InvestorAmounts, type InvestorSummary } from '../../../src/lib/financing/bond-investors';
  import { PERMISSION_CODES } from '../../../src/lib/permissions';
  import '../../../src/routes/financing/layout.css';
  const amounts=(publicBond:number,privateBond:number,short:number):InvestorAmounts=>({...emptyInvestorAmounts(),公募债:publicBond,私募债:privateBond,短融:short,total:publicBond+privateBond+short});
  const investors:InvestorSummary[]=[
    {id:'1',name:'银行甲',category:'股份制银行',total:amounts(20,10,30),outstanding:amounts(18,0,0)},
    {id:'2',name:'基金乙',category:'公募基金',total:amounts(10,5,35),outstanding:amounts(8,0,25)},
    {id:'3',name:'理财丙',category:'银行理财',total:amounts(15,8,25),outstanding:amounts(12,0,10)},
    ...(['券商资管','国有银行','城农商行','券商自营','保险资管','其他'] as const).map((category,index)=>({id:String(index+4),name:['资管丁','银行戊','农商己','证券庚','保险辛','机构壬'][index]??category,category,total:amounts(2+index,0,1),outstanding:amounts(1+index/2,0,0)})),
  ];
  const sum=(rows:InvestorSummary[],metric:'total'|'outstanding')=>rows.reduce((acc,row)=>{
    for(const key of Object.keys(acc) as (keyof InvestorAmounts)[])acc[key]+=row[metric][key];return acc;
  },emptyInvestorAmounts());
  const report={asOfDate:'2026-09-15',investors,total:sum(investors,'total'),outstanding:sum(investors,'outstanding'),
    categories:investorCategories.map(category=>({category,total:sum(investors.filter(r=>r.category===category),'total'),outstanding:sum(investors.filter(r=>r.category===category),'outstanding')})),
    coverage:{coveredBonds:3,missingBonds:0,mismatchedBonds:0,missingAmountYi:0}};
  const data={permissions:[...PERMISSION_CODES],user:null,account:null,session:null,auth0:true,reminders:{items:[],total:0},report};
</script>
<WorkbenchShell title="融资工作台" homeHref="/financing/" views={[{id:'investors',label:'债券投资人',href:'/financing/bond-investors',icon:'user'}]} activeViewId="investors" class="financing-scope">
  <InvestorsPage {data}/>
</WorkbenchShell>
