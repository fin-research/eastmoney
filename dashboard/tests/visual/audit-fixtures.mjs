import {credit,today} from './fixtures.mjs';
import {creditItemTypes,creditItemLabels} from '../../src/lib/credit/types.ts';
export const creditFull=structuredClone(credit);
creditFull.previousDate='2026-09-08';
creditFull.previousSummary={...creditFull.summary,reportDate:'2026-09-08',totalLimit:28,totalUsed:9,totalAvailable:19,utilization:32.14,expiringWithin30Days:0};
creditFull.previousWeeklySummary={...creditFull.previousSummary,addedInstitutionCount:2,expiredInstitutionCount:1};
for(const institution of creditFull.institutions){
  institution.effectiveDate='2026-01-01';
  institution.updatedAt='2026-09-15T08:00:00Z';
  institution.clients=[{id:'fixture-client',name:'测试关联客户'}];
  institution.bankOffice='总行金融市场部';institution.applyingDepartment='资金管理部';institution.handler='测试经办人';
  institution.items=creditItemTypes.map((type,i)=>({type,limitAmount:3,usedAmount:[2,1,.5,.5,0][i],remainingAmount:3-[2,1,.5,.5,0][i],details:i?'按协议约定使用':'债券投资额度，一级与二级分别登记',primaryUsedAmount:type==='bond_investment'?1.5:null,secondaryUsedAmount:type==='bond_investment'?.5:null,usageSource:['bond_investment','yield_certificate','interbank_lending'].includes(type)?'financing':'credit'}));
}
creditFull.previousInstitutions=creditFull.institutions.map((row,i)=>({...structuredClone(row),
  reportDate:'2026-09-08',totalLimit:i?18:10,totalUsed:i?4:5,
  items:row.items.map(item=>({...item,usedAmount:item.type==='other'&&!i?1:item.usedAmount}))}));
creditFull.calendarEvents=[
  ...['new','expiry','renewal','increase','revoked'].map((kind,i)=>({id:kind,type:kind==='expiry'||kind==='revoked'?'expiry':'added',kind,institutionName:i%2?'银行乙':'银行甲',label:['授信新增 · 15亿元','授信到期 · 15亿元','授信续作 · 15亿元','授信扩额 · 20亿元','授信撤销 · 15亿元'][i],date:`2026-09-${String(14+i).padStart(2,'0')}`,status:'completed',statusLabel:'已生效'})),
  ...creditItemTypes.map((itemType,i)=>({id:itemType,type:'usage',kind:'usage',itemType,institutionName:'银行甲',label:`${creditItemLabels[itemType]} · 增加1亿元`,date:`2026-09-${String(14+i).padStart(2,'0')}`,status:'completed',statusLabel:'已生效'})),
];
creditFull.weeklyNews=[{reportDate:today,previousReportDate:'2026-09-08',institutionName:'银行甲',institutionType:'商业银行',eventType:'increase',previousStatus:'approved',currentStatus:'approved',previousAmount:10,currentAmount:15,deltaAmount:5,previousEffectiveDate:'2026-01-01',currentEffectiveDate:'2026-01-01',previousExpiryDate:'2026-09-14',currentExpiryDate:'2026-09-30',creditDetails:creditFull.institutions[0].items.map(item=>({type:item.type,limitAmount:item.limitAmount,details:item.details}))}];
creditFull.recentApprovals=creditFull.weeklyNews;

export const hotspotAudit={date:today,generatedAt:`${today}T10:00:00+08:00`,model:'fixture',cached:true,
  marketSummary:'资金价格保持平稳，债券供给与机构配置需求共同影响利率走势；关注政策落地、资金跨季与外部利率变化。',
  scope:{mode:'rolling',rollingCount:20,articleCount:20,firstPublishedAt:'2026-09-14',lastPublishedAt:today},
  hotspots:['资金面','债券供给','机构配置','货币政策','财政支出','海外利率','房地产政策','风险偏好'].map((keyword,i)=>({keyword,aliases:[],heat:85-i*6,confidence:i<4?'high':'medium',sourceLabel:'多来源',explanation:`${keyword}通过融资需求和资产配置影响市场定价。政策预期与实际数据仍需交叉验证，短期波动不改变中期观察框架。`,drivers:['政策落地节奏','机构配置需求'],conflicts:i===1?['短期供给压力与中期配置需求并存。']:[],assetImpacts:{fixedIncome:'关注融资成本与期限利差变化，跟踪配置需求能否承接新增供给。',equities:'关注流动性环境和盈利预期的共同变化。'},evidence:[{articleId:`A00${i+1}`,evidence:'机构报告指出，资金价格和债券供给的相对变化是本期市场关注的主要因素。'}]})),
  relationships:[{source:'资金面',target:'机构配置',explanation:'负债成本变化影响机构配置节奏。'},{source:'货币政策',target:'资金面',explanation:'公开市场操作影响短端资金供求。'}],watchItems:['跨季资金价格','新增债券发行节奏'],coverage:{articleCount:20,analyzedArticleIds:['A001','A002']}};

export const auditArticles=[{id:'A001',title:'流动性环境与债券配置窗口分析',author:'研究机构甲',summary:'资金需求回落与供给节奏变化共同影响债市，需关注跨季时点和负债成本。',publishedAt:`${today}T09:00:00+08:00`,link:null,associationMethod:'manual'},
{id:'A002',title:'财政支出提速对短期资金面的影响',author:'研究机构乙',summary:'财政支出可以阶段性改善银行间流动性，仍需结合公开市场操作和缴税节奏观察。',publishedAt:`${today}T10:00:00+08:00`,link:null,associationMethod:'ai'}];
export const policyAudit=[{id:'policy-1',title:'完善货币政策工具安排，保持流动性合理充裕',summary:'政策强调统筹总量和结构性工具，保持资金供求平衡，引导金融机构加大对重点领域的支持力度。',category:'monetary',importance:'important',departments:['中国人民银行'],policyDate:today,firstNewsAt:today,lastNewsAt:today,updatedAt:today,news:[{id:'news-1',newsId:'news-1',title:'有关部门发布货币政策工具安排',publishedAt:`${today}T09:00:00+08:00`,link:null}],articles:auditArticles,commentary:null},
{id:'policy-2',title:'加快财政资金拨付，支持重点项目建设',summary:'推进资金拨付和项目落地，发挥财政支出对有效需求的带动作用。',category:'fiscal',importance:'related',departments:['财政部','国家发展改革委'],policyDate:'2026-09-14',firstNewsAt:today,lastNewsAt:today,updatedAt:today,news:[],articles:[],commentary:null}];

export const commentaryAudit={id:'archive-1',policyId:null,type:'current_affairs',eventName:'资金价格下移与融资窗口',sources:'研究机构甲',eventPublishedAt:today,commentaryDate:today,eventSummary:'资金需求阶段性回落，债券供给节奏有所放缓，发行窗口具备进一步观察条件。',commentary:'1. 资金价格下移打开融资窗口\n资金需求回落，负债成本下降，公司债发行具备有利条件。\n\n2. 供给与配置需求仍需结合观察\n后续关注发行节奏和机构负债稳定性，避免将短期波动直接外推。',recommendation:'融资发行方面，前置中长期公司债发行准备，并结合实际簿记需求安排发行节奏。',model:null,promptVersion:null,generatedAt:null,edited:true,updatedAt:`${today}T03:00:00Z`,origin:'import',originalText:'资金需求回落，融资窗口打开。',sourceFiles:[],evidence:[],search:null};

export const assistantSession={turns:[{id:'audit-turn',question:'请核实公司流动性指标，并列出资料来源。',createdAt:`${today}T03:00:00Z`,answer:{status:'partial',paragraphs:[{text:'截至报告期末，公司流动性覆盖率为180%，净稳定资金率为125%。',citations:[{sourceId:'audit-source',quote:'期末流动性覆盖率为180%，净稳定资金率为125%。'}]}],gaps:['最新月份的流动性指标尚待业务部门确认。'],sources:[{id:'audit-source',documentId:'credit/public/测试公司2026年半年度报告.pdf',locator:'AI Search 检索片段',title:'测试公司2026年半年度报告.pdf',url:'/audit-document.pdf',extraction:'ai_search'}],files:[],createdAt:`${today}T03:00:00Z`}}],running:false,progress:'',error:null,startedAt:0};

export const detailContent='## 一、资金供需变化\n\n资金价格回落并不意味着供给压力消失。应结合财政收支、公开市场操作与机构负债稳定性，观察变化能否持续。\n\n## 二、重点观察项目\n\n- 跟踪跨季资金需求与主要回购利率。\n- 观察公司债发行节奏和投资者认购结构。\n\n| 观察项目 | 本期变化 | 后续观察 |\n| --- | --- | --- |\n| 流动性 | 总体平稳 | 跨季与缴税时点 |\n| 债券供给 | 节奏放缓 | 发行窗口和认购需求 |\n\n## 三、业务安排\n\n前置准备发行材料，结合实际簿记需求安排发行节奏。';
export const newsDetailAudit={...policyAudit[0].news[0],content:detailContent,policy:policyAudit[0]};
export const articleDetailAudit={...auditArticles[0],content:detailContent,policies:policyAudit};
export const commentaryDetailAudit={commentary:{...commentaryAudit,eventName:'资金价格下移与公司债融资窗口：跨季流动性变化、发行供给与机构配置需求的联动观察'},policy:policyAudit[0]};
