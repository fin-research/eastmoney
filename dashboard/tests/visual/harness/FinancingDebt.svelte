<script lang="ts">
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import DebtPage from '../../../src/routes/financing/debts/[id]/+page.svelte';
  import { PERMISSION_CODES } from '../../../src/lib/permissions';
  import '../../../src/routes/financing/layout.css';
  const debt={id:'1',name:'吉祥231号收益凭证',debtType:'收益凭证',subtype:'固定收益凭证',counterparty:'银行甲',status:'matured',
    amount:1e9,interestPayable:185e5,totalAmount:10185e5,annualRate:.0185,issueDate:'2025-09-02',maturityDate:'2026-09-02',
    cashflows:[{id:'1:1',eventDate:'2026-09-02',eventType:'interest',amount:185e5,paidAmount:185e5}],
    fields:[['清盘提交','—'],['清盘注册','—'],['收益类型','固定'],['收款账户','结算账户甲'],['是否提前到期','否']].map(([fieldName,displayValue])=>({fieldName,displayValue,rowSequence:0}))};
  const data={permissions:[...PERMISSION_CODES],user:null,account:null,session:null,auth0:true,reminders:{items:[],total:0},debt};
</script>
<WorkbenchShell title="融资工作台" homeHref="/financing/" views={[{id:'debt',label:'负债详情',href:'/financing/debts/1',icon:'database'}]} activeViewId="debt" class="financing-scope">
  <DebtPage {data}/>
</WorkbenchShell>
