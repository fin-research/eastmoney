<script lang="ts">
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import ClientsPage from '../../../src/routes/financing/clients/+page.svelte';
  import '../../../src/routes/financing/layout.css';
  import type { WorkbenchPageLink } from '../../../src/lib/workbench/navigation';
  import type { ClientRecord } from '../../../src/lib/financing/client-input';
  import { PERMISSION_CODES } from '../../../src/lib/permissions';
  const views: WorkbenchPageLink[] = [{ id:'clients',label:'客户名单',href:'/financing/clients',icon:'user' }];
  const query=new URL(window.location.href).searchParams.get('q')??'';
  const clients:ClientRecord[]=[
    {id:'1',name:'银行甲',fullname:'银行甲股份有限公司',type:'银行',subtype:'股份行',aliases:['甲行'],version:'1'},
    {id:'2',name:'证券乙',fullname:'证券乙股份有限公司',type:'券商',subtype:'自营',aliases:[],version:'1'},
  ];
  const rows=clients.filter(row=>[row.name,row.fullname,...row.aliases].join(' ').includes(query));
  const data={permissions:[...PERMISSION_CODES],user:null,account:null,session:null,auth0:true,
    reminders:{items:[],total:0},rows,total:rows.length,query,page:1};
</script>
<WorkbenchShell title="融资工作台" homeHref="/financing/" {views} activeViewId="clients" class="financing-scope">
  <ClientsPage {data}/>
</WorkbenchShell>
