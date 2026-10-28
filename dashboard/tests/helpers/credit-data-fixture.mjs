// Visual/DOM fixtures provide canonical facts to the real browser builder.
// This adapter is test-only; production never accepts assembled report DTOs.
export function creditDataFixture(report) {
  const reportDate=report.summary.reportDate,previousDate=report.previousDate;
  const month=reportDate.slice(0,7),shift=(date,n)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
  const savedStates=[],usage=[],links=[],rows=[],usageEventRows=[];
  const states=new Map();
  const rowFor=(institution,date)=>{
    const state={institution_name:institution.institutionName,institution_type:institution.institutionType,
      status:institution.status,confidentiality_status:institution.confidentialityStatus,total:institution.totalLimit,
      effective_date:institution.effectiveDate,expiry_date:institution.expiryDate,last_changed_on:institution.lastChangedOn,verified:institution.verified ?? false,
      bank_office:institution.bankOffice,applying_department:institution.applyingDepartment,handler:institution.handler,
      detail:institution.detail,notes:institution.notes,bond_preference:institution.bondPreference,
      updated_at:institution.updatedAt,created_at:institution.updatedAt,bond_investment_secondary_used:0};
    const items=institution.items?.length?institution.items:[{type:'other',usedAmount:institution.totalUsed,details:null}];
    for(const item of items){state[item.type+'_limit']=item.limitAmount;state[item.type+'_detail']=item.details;
      state[item.type+'_used']=item.usedAmount;if(item.type==='bond_investment')state.bond_investment_secondary_used=item.secondaryUsedAmount??0;
      if(['bond_investment','yield_certificate','interbank_lending'].includes(item.type))usage.push({date,institution_name:institution.institutionName,item_type:item.type,amount:item.primaryUsedAmount??(item.type==='bond_investment'?(item.usedAmount??0)-(item.secondaryUsedAmount??0):item.usedAmount??0)});
    }
    const record={date,data:state};states.set(date+':'+institution.institutionName,record);return state;
  };
  const institutions=report.institutions;
  for(const institution of institutions){rowFor(institution,reportDate);if(previousDate)rowFor(report.previousInstitutions?.find(i=>i.institutionName===institution.institutionName)??institution,previousDate);
    for(const client of institution.clients??[])links.push({institution_name:institution.institutionName,id:client.id,name:client.name});
  }
  for(const event of [...(report.recentApprovals??[]),...(report.weeklyNews??[])]){
    const institution=institutions.find(i=>i.institutionName===event.institutionName)??{...institutions[0],institutionName:event.institutionName};
    const beforeDate=shift(event.reportDate,-1);
    if(!states.has(beforeDate+':'+institution.institutionName))rowFor({...institution,totalLimit:event.previousAmount,effectiveDate:event.previousEffectiveDate,expiryDate:event.previousExpiryDate},beforeDate);
    if(!states.has(event.reportDate+':'+institution.institutionName))rowFor({...institution,totalLimit:event.currentAmount,effectiveDate:event.currentEffectiveDate,expiryDate:event.currentExpiryDate},event.reportDate);
    if(!rows.some(r=>r.effective_on===event.reportDate&&r.institution_name===institution.institutionName))rows.push({institution_name:institution.institutionName,effective_on:event.reportDate,type:event.eventType,expiry_date:event.currentExpiryDate});
  }
  savedStates.push(...states.values());
  const sixMonths=new Date(reportDate+'T00:00:00Z');sixMonths.setUTCMonth(sixMonths.getUTCMonth()-6);
  return {reportDate,previousDate,calendarMonth:month,calendarStart:shift(month+'-01',-6),calendarEnd:shift(month+'-01',41),
    sixMonthStart:sixMonths.toISOString().slice(0,10),availableDates:[...report.availableDates].sort(),savedStates,usage,links,rows,usageEventRows};
}

export function creditDataPatch(report,input){
  const data=creditDataFixture(report),name=input.institutionName;
  for(const key of ['rows','links','usageEventRows','usage'])data[key]=data[key].filter(row=>row.institution_name===name);
  data.savedStates=data.savedStates.filter(row=>row.data.institution_name===name);
  return {institutionName:name,viewDate:input.viewDate,calendarMonth:input.calendarMonth,scope:'institution',data};
}

// Independent credit facts and usage facts exercise the calendar's two filters.
export function creditCalendarDataFixture(report,month,itemTypes){
  const data=creditDataFixture(report),date=month+'-04';
  const dayBefore=new Date(date+'T00:00:00Z');dayBefore.setUTCDate(dayBefore.getUTCDate()-1);
  const beforeDate=dayBefore.toISOString().slice(0,10);
  const monthStart=new Date(month+'-01T00:00:00Z'),shift=n=>{const day=new Date(monthStart);day.setUTCDate(day.getUTCDate()+n);return day.toISOString().slice(0,10);};
  Object.assign(data,{availableDates:['2026-08-01',...data.availableDates],calendarMonth:month,calendarStart:shift(-6),calendarEnd:shift(41),rows:[],links:[],savedStates:[],usage:[],usageEventRows:[]});
  const state=name=>({institution_name:name,institution_type:'商业银行',status:'approved',total:10,effective_date:'2026-01-01',expiry_date:'2027-12-31',bond_investment_secondary_used:0,legal_overdraft_used:0,other_used:0});
  const add=(on,record)=>data.savedStates.push({date:on,data:{...record,status:record.expiry_date==='1970-01-01'?'revoked':record.expiry_date?(on<=record.expiry_date?'approved':'applying'):record.status}});
  for(const kind of ['new','expiry','renewal','increase','revoked']){
    const before=state(kind),after={...before};
    if(kind==='new'){before.status='applying';before.total=0;after.effective_date=date;}
    if(kind==='expiry')before.expiry_date=after.expiry_date=date;
    if(kind==='renewal')before.expiry_date='2026-08-01';
    if(kind==='increase')after.total=15;
    if(kind==='revoked'){after.status='revoked';after.expiry_date='1970-01-01';}
    add(beforeDate,before);add(date,after);
    if(data.reportDate!==beforeDate&&data.reportDate!==date)add(data.reportDate,date<=data.reportDate?after:before);
    data.rows.push({institution_name:kind,effective_on:kind==='expiry'?'2026-01-01':date,type:kind==='expiry'?'maintenance':kind==='revoked'?'revocation':kind,expiry_date:after.expiry_date});
  }
  for(const type of itemTypes){
    const before=state(type),after={...before};
    data.links.push({institution_name:type,id:type,name:type});
    if(type==='bond_investment')after.bond_investment_secondary_used=1;
    else if(['legal_overdraft','other'].includes(type))after[type+'_used']=1;
    else {data.usage.push({date,institution_name:type,item_type:type,amount:1});data.usageEventRows.push({date,institution_name:type});}
    if(!['yield_certificate','interbank_lending'].includes(type))data.rows.push({institution_name:type,effective_on:date,type:'maintenance',expiry_date:after.expiry_date});
    add(beforeDate,before);add(date,after);
    if(data.reportDate!==beforeDate&&data.reportDate!==date){add(data.reportDate,date<=data.reportDate?after:before);if(date<=data.reportDate&&['yield_certificate','interbank_lending'].includes(type))data.usage.push({date:data.reportDate,institution_name:type,item_type:type,amount:1});}
  }
  return data;
}
