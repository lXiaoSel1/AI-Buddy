import {providerFor} from './token-types.mjs';
const empty=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,total:0,requests:0});
export function selectTokenStatistics(data,{tool='all',vendor='all',purpose='all',source='all',query=''}={}){
 if(!data?.cube||[tool,vendor,purpose,source].every(v=>v==='all')&&!query)return data;
 const daily=new Map(),projects=new Map(),totals={};let missingRequests=0;
 for(const r of data.cube){if(tool!=='all'&&r.tool!==tool||vendor!=='all'&&r.serviceProvider!==vendor&&providerFor(r.model)!==vendor||purpose!=='all'&&r.purpose!==purpose||source!=='all'&&r.sourceId!==source||query&&![r.workspace,r.model].join(' ').toLowerCase().includes(query.toLowerCase()))continue;
  const add=(target)=>{target[r.tool]??=empty();for(const k of Object.keys(empty())){target[r.tool][k]+=r.usage[k]||0;if(r.usage.fieldMissing?.[k]){target[r.tool].fieldMissing??={};target[r.tool].fieldMissing[k]=(target[r.tool].fieldMissing[k]||0)+r.usage.fieldMissing[k];}}};add(totals);const d=daily.get(r.date)||{date:r.date};add(d);daily.set(r.date,d);const p=projects.get(r.workspace)||{workspace:r.workspace,sessions:0};add(p);projects.set(r.workspace,p);missingRequests+=r.missingRequests||0;
 }
 for(const s of data.sessions||[])if(projects.has(s.workspace)&&(tool==='all'||s.provider===tool)&&(vendor==='all'||s.serviceProvider===vendor||providerFor(s.model)===vendor)&&(purpose==='all'||s.purpose===purpose)&&(source==='all'||s.sourceId===source))projects.get(s.workspace).sessions++;
 return {...data,totals,daily:[...daily.values()].sort((a,b)=>b.date.localeCompare(a.date)),projects:[...projects.values()],todayUsage:daily.get(data.today)||{date:data.today},missingRequests};
}
