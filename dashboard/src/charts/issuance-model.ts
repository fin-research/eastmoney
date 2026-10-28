import type { IssuanceSnapshot } from '../lib/issuance-model';
import { colors, axisLabel, gridLine, tooltip, escapeHtml } from './common';
import { setChart, setEmpty } from './charting';

export { issuanceFeatureName } from '../lib/issuance-presentation';
export function renderIssuanceForecast(host:HTMLElement,rows:IssuanceSnapshot['forecast']):void {
  if(!rows.length){setEmpty(host,'窗口内无发行日期');return;}
  setChart(host,{animationDuration:180,aria:{enabled:true,description:'未来发行日预计票面'},tooltip:{...tooltip,trigger:'axis'},legend:{top:0,textStyle:axisLabel},
    grid:{left:12,right:16,top:45,bottom:10,containLabel:true},
    xAxis:{type:'category',data:rows.map(r=>r.date),axisLabel:{...axisLabel,formatter:(v:string)=>v.slice(5)},axisTick:{show:false}},
    yAxis:{type:'value',name:'票面 %',scale:true,axisLabel,splitLine:gridLine},
    series:[{name:'预计票面',type:'line',data:rows.map(r=>r.coupon_percent),itemStyle:{color:colors.brand}}]});
}

export function renderIssuanceProductComparison(host:HTMLElement,rows:IssuanceSnapshot['product_scenarios']):void {
  if(!rows.length){setEmpty(host,'品种预测暂缺');return;}
  const names=rows.map(row=>`${row.tenor}年${{
    '证券公司债':'公募债','证券公司次级债':'次级债',
  }[row.bond_type]}`);
  setChart(host,{animationDuration:180,aria:{enabled:true,description:'3年与5年公募债和次级债预计票面对比'},
    legend:{top:0,textStyle:axisLabel,data:['预计票面']},
    grid:{left:12,right:80,top:35,bottom:30,containLabel:true},
    tooltip:{...tooltip,trigger:'axis',axisPointer:{type:'shadow'},formatter:(params:unknown)=>{
      const index=(params as Array<{dataIndex:number}>)[0]?.dataIndex??-1;
      const row=rows[index];if(!row)return '';
      return `<strong>${escapeHtml(names[index]??'')}</strong><br>预计票面 ${row.coupon_percent===null?'—':`${row.coupon_percent.toFixed(2)}%`}<br>同类历史 ${row.own_observations}笔本机构 / ${row.peer_observations}笔合计`;
    }},
    xAxis:{type:'value',name:'预计票面 %',scale:true,axisLabel,splitLine:{lineStyle:gridLine}},
    yAxis:{type:'category',inverse:true,data:names,axisLabel:{...axisLabel,color:colors.ink},axisTick:{show:false}},
    series:[{name:'预计票面',type:'bar',barMaxWidth:24,data:rows.map(row=>({value:row.coupon_percent,
      itemStyle:{color:colors.brand,borderRadius:[0,4,4,0]}})),
      label:{show:true,position:'right',formatter:(param:{dataIndex:number})=>rows[param.dataIndex]?.coupon_percent==null?'—':`${rows[param.dataIndex]!.coupon_percent!.toFixed(2)}%`}}]});
}
export function renderIssuanceMarket(host:HTMLElement,rows:IssuanceSnapshot['market_forecast']):void {
  setChart(host,{aria:{enabled:true},tooltip:{...tooltip,trigger:'axis'},grid:{left:12,right:16,top:30,bottom:10,containLabel:true},
    xAxis:{type:'category',data:rows.map(r=>r.date),axisLabel:{...axisLabel,formatter:(v:string)=>v.slice(5)}},
    yAxis:{type:'value',name:'AAA 3Y %',scale:true,axisLabel,splitLine:gridLine},
    series:[{name:'市场利率',type:'line',data:rows.map(r=>r.market_level_percent),symbol:'none',itemStyle:{color:colors.brand}}]});
}
