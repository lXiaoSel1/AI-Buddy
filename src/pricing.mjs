import bundled from './price-snapshot.json' with {type:'json'};
import {join} from 'node:path';
import {createSnapshotStorage,readJson} from './storage.mjs';
import {providerFor} from './token-types.mjs';
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function catalogFromModels(data,at=new Date().toISOString()){
 const rows={};for(const [provider,p]of Object.entries(data)){if(!p?.models)continue;for(const [model,m]of Object.entries(p.models)){if(!finite(m.cost?.input)||!finite(m.cost?.output))continue;rows[provider+'/'+model]={provider,model,currency:'USD',input:m.cost.input,output:m.cost.output,cacheRead:m.cost.cache_read,cacheWrite:m.cost.cache_write,tiers:(m.cost.tiers||[]).filter(t=>t.tier?.type==='context'&&finite(t.tier.size)&&finite(t.input)&&finite(t.output)).map(t=>({threshold:t.tier.size,input:t.input,output:t.output,cacheRead:t.cache_read,cacheWrite:t.cache_write})),source:'models.dev'};}}
 if(!Object.keys(rows).length)throw Error('价格目录无有效记录');return {version:at,updatedAt:at,source:'https://models.dev/api.json',rows};
}
const providerAliases={zhipu:'zhipuai',moonshot:'moonshotai',volcengine:'volcengine',qwen:'alibaba',kimi:'kimi-for-coding'};
export class PriceService{
 constructor({dataRoot,fetchImpl=fetch,bundle=bundled}){this.store=createSnapshotStorage(join(dataRoot,'price-settings-v1.json'));this.fetch=fetchImpl;this.bundle=bundle;this.revision=0;this.ready=readJson(this.store,{overrides:[],catalog:null,autoUpdate:false}).then(s=>{this.state=s;return this;});}
 info(){const c=this.state?.catalog||this.bundle;return {version:c.version,updatedAt:c.updatedAt,source:c.source,autoUpdate:this.state?.autoUpdate||false,overrideCount:this.state?.overrides.length||0};}
 view(){return {...this.info(),overrides:this.state?.overrides||[]};}
 catalog(options={},used=[]){
  const rows=new Map();for(const [id,r]of Object.entries(this.bundle.rows))rows.set(id,{...r,billingRoute:'api',priceVersion:this.bundle.version,origin:'bundled'});
  for(const [id,r]of Object.entries(this.state?.catalog?.rows||{}))rows.set(id,{...r,billingRoute:'api',priceVersion:this.state.catalog.version,origin:'catalog'});
  (this.state?.overrides||[]).forEach((r,index)=>{const provider=providerAliases[r.provider]||r.provider,key=provider+'/'+r.model,route=r.billingRoute||'api';rows.set(route==='api'?key:key+'@'+route,{...r,provider,billingRoute:route,origin:'custom',overrideIndex:index,priceVersion:'custom-'+this.revision});});
  const usedKeys=new Set();for(const r of used){const picked=this.referenceRate(r);if(picked)usedKeys.add(picked.priceProvider+'/'+picked.priceModel);else{const key=(r.serviceProvider||'unknown')+'/'+r.model;if(!rows.has(key))rows.set(key,{provider:r.serviceProvider||'unknown',model:r.model,origin:'missing',billingRoute:r.billingRoute||'unknown'});usedKeys.add(key);}}
  const all=[...rows.values()].map(r=>({...r,used:usedKeys.has(r.provider+'/'+r.model)})),providers=[...new Set(all.map(r=>r.provider))].sort(),query=String(options.search||'').toLowerCase();
  const filtered=all.filter(r=>(!options.provider||options.provider==='all'||r.provider===options.provider)&&(!query||r.model.toLowerCase().includes(query))&&(options.scope!=='custom'||r.origin==='custom')&&(options.scope!=='used'||r.used)).sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model)||a.billingRoute.localeCompare(b.billingRoute));
  const pages=Math.max(1,Math.ceil(filtered.length/50)),page=Math.min(pages,Math.max(1,Math.floor(Number(options.page)||1)));
  return {...this.view(),providers,total:filtered.length,page,pages,pageSize:50,rows:filtered.slice((page-1)*50,page*50)};
 }
 async save(value){await this.ready;const overrides=value.overrides??this.state.overrides;if(!Array.isArray(overrides)||overrides.length>1000)throw Error('价格配置无效');for(const r of overrides){if(r.billingRoute&&!['api','proxy','subscription','account','coding-plan'].includes(r.billingRoute))throw Error('计费路线无效');if(!r.provider||!r.model||!['USD','CNY','EUR','GBP','JPY'].includes(r.currency)||!finite(r.input)||!finite(r.output))throw Error('请填写提供方、模型、币种及有效单价');for(const k of ['cacheRead','cacheWrite','cacheWrite1h'])if(r[k]!=null&&!finite(r[k]))throw Error('缓存价格无效');for(const t of r.tiers||[])if(!finite(t.threshold)||!finite(t.input)||!finite(t.output))throw Error('阶梯价格无效');}const next={...this.state,overrides,autoUpdate:value.autoUpdate??this.state.autoUpdate};await this.store.writeText(JSON.stringify(next));this.state=next;this.revision++;return this.view();}
 async refresh(){await this.ready;if(this.refreshing)return this.refreshing;this.refreshing=(async()=>{const r=await this.fetch('https://models.dev/api.json',{signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw Error('价格更新失败 HTTP '+r.status);const body=await r.text();if(body.length>20*1024*1024)throw Error('价格目录过大');const catalog=catalogFromModels(JSON.parse(body));const next={...this.state,catalog};await this.store.writeText(JSON.stringify(next));this.state=next;this.revision++;return this.view();})();try{return await this.refreshing;}finally{this.refreshing=null;}}
 async tick(){if(this.state?.autoUpdate&&Date.now()-Date.parse(this.info().updatedAt)>86400000&&Date.now()-(this.lastAttempt||0)>3600000){this.lastAttempt=Date.now();await this.refresh();}}
 referenceRate(r){
  if(this.rateRevision!==this.revision){this.rateCache=new Map();this.rateRevision=this.revision;}
  const key=JSON.stringify([r.serviceProvider,r.model,r.modelVendor,r.billingRoute]);if(this.rateCache.has(key))return this.rateCache.get(key);
  const canonical=p=>providerAliases[p]||p,platform=canonical(r.serviceProvider),model=String(r.model||''),vendor=canonical(r.modelVendor&&r.modelVendor!=='unknown'?r.modelVendor:providerFor(model.split('/').at(-1))),route=r.billingRoute||'unknown';
  const candidates=[];if(platform&&platform!=='unknown')candidates.push({provider:platform,model,kind:'platform-api'});
  if(vendor&&vendor!=='unknown'){const referenceModel=model.split('/').at(-1);if(!candidates.some(c=>c.provider===vendor&&c.model===referenceModel))candidates.push({provider:vendor,model:referenceModel,kind:'model-api'});}
  let chosen=null;
  for(const c of candidates){
   const overrides=(this.state?.overrides||[]).filter(p=>canonical(p.provider)===c.provider&&p.model===c.model);
   const override=overrides.find(p=>(p.billingRoute||'api')===route)||overrides.find(p=>(p.billingRoute||'api')==='api');
   const id=c.provider+'/'+c.model,catalog=this.state?.catalog?.rows[id]?this.state.catalog:this.bundle,rate=override||catalog.rows[id];
   if(rate){chosen={rate,priceProvider:c.provider,priceModel:c.model,priceBasis:override?'user':c.kind,source:override?'用户自定义':rate.source||catalog.source,version:override?'custom-'+this.revision:catalog.version};break;}
  }
  this.rateCache.set(key,chosen);return chosen;
 }
 estimate(r){const fail=reason=>({amount:null,reason}),reference=this.referenceRate(r);if(!reference)return fail('缺少该模型的参考价格');const {rate}=reference;
  const u=r.usage;if(u.input===null||u.output===null)return fail('输入或输出口径不完整');
  let inputTotal=u.input+(u.cacheRead||0)+(u.cacheWrite||0),chosen=rate;for(const t of [...(rate.tiers||[])].sort((a,b)=>a.threshold-b.threshold))if(inputTotal>t.threshold)chosen={...rate,...t};
  let amount=0;for(const key of ['input','output','cacheRead','cacheWrite']){const n=u[key];if(n===null){if(key==='cacheWrite'&&r.cacheIncluded===true)continue;return fail('缺少缓存用量');}if(n>0&&!finite(chosen[key]))return fail('缺少缓存单价');amount+=(n||0)*(chosen[key]||0)/1e6;}
  if(r.cacheWrite1h>0){if(!finite(chosen.cacheWrite1h))return fail('缺少一小时缓存写入价格');amount+=r.cacheWrite1h*(chosen.cacheWrite1h-chosen.cacheWrite)/1e6;}
  const {rate:_,...provenance}=reference;return {amount,currency:rate.currency,...provenance};
 }
}
