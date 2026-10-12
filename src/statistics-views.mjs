export const SORT_OPTIONS=Object.freeze({'total:desc':'总 Token · 从大到小','total:asc':'总 Token · 从小到大','input:desc':'输入 · 从大到小','input:asc':'输入 · 从小到大','output:desc':'输出 · 从大到小','output:asc':'输出 · 从小到大','name:asc':'项目名称 · 正序','name:desc':'项目名称 · 倒序'});
export const defaultView=page=>({preset:page==='overview'?'today':page==='history'?'30d':'all',group:'day',sortField:'total',sortDirection:'desc',visibleTools:null});
export const defaultViews=()=>Object.fromEntries(['overview','projects','history'].map(page=>[page,defaultView(page)]));
export function validateViews(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('统计视图设置无效');const result=defaultViews();
 for(const [page,v] of Object.entries(value)){if(!Object.hasOwn(result,page)||!v||typeof v!=='object'||Array.isArray(v))throw Error('统计页面无效');const out={...result[page]};for(const[k,x]of Object.entries(v)){
  if(k==='preset'){if(!['today','7d','30d','all','custom'].includes(x))throw Error('时间范围无效');}
  else if(k==='group'){if(!['day','week','month'].includes(x))throw Error('聚合粒度无效');}
  else if(k==='sortField'){if(!['total','input','output','name'].includes(x))throw Error('排序字段无效');}
  else if(k==='sortDirection'){if(!['asc','desc'].includes(x))throw Error('排序方向无效');}
  else if(k==='visibleTools'){if(x!==null&&(!Array.isArray(x)||x.length>100||x.some(s=>typeof s!=='string'||s.length>100)))throw Error('工具显示设置无效');}
  else if(['from','to','tool','modelVendor','provider','model','workspace','sourceId','purpose','search'].includes(k)){if(typeof x!=='string'||x.length>2000)throw Error('筛选设置无效');if(['from','to'].includes(k)&&x&&(!/^\d{4}-\d{2}-\d{2}$/.test(x)||new Date(x+'T00:00:00Z').toISOString().slice(0,10)!==x))throw Error('日期无效');}
  else throw Error('未知统计设置：'+k);out[k]=Array.isArray(x)?[...x]:x;
 }if(out.from&&out.to&&out.from>out.to)throw Error('开始日期不能晚于结束日期');result[page]=out;}return result;
}
export function compactNumber(n){if(n==null)return '未提供';const a=Math.abs(n);for(const [unit,scale] of [['B',1e9],['M',1e6],['K',1e3]])if(a>=scale)return new Intl.NumberFormat('en',{maximumFractionDigits:2}).format(n/scale)+unit;return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);}
