// One-off B0 step: retire the --dsw-alias-* variables (several were used but never defined)
// and drop colour fallbacks from var(--buddy-*), which is always defined now.
// Usage: node retire-aliases.mjs [--write] <file>...
import {readFileSync,writeFileSync} from 'node:fs';
const MAP={'bg-base':'bg','bg-l1':'surface','bg-l2':'surface2','bg-layer-2':'surface2','bg-layer-3':'surface2','bg-module-platform':'surface','border-l2':'border','border-l3':'accent','brand-primary':'accent','accent':'accent','label-primary':'text','text-primary':'text','label-secondary':'muted','label-tertiary':'muted','label-dimmed':'muted','text-secondary':'muted','text-tertiary':'muted','label-error':'err'};
const FALLBACK='(?:,\\s*(?:[^()]|\\([^()]*\\))*)?';
const write=process.argv.includes('--write');
for(const file of process.argv.slice(2).filter(a=>!a.startsWith('--'))){
 const text=readFileSync(file,'utf8');let out=text,unknown=new Set();
 out=out.replace(new RegExp('var\\(--dsw-alias-([a-z0-9-]+)'+FALLBACK+'\\)','g'),(all,name)=>{if(!MAP[name]){unknown.add(name);return all;}return `var(--buddy-${MAP[name]})`;});
 out=out.replace(/--dsw-alias-[a-z0-9-]+:(?:[^;}()]|\([^()]*\)|\((?:[^()]|\([^()]*\))*\))*;?/g,'');
 out=out.replace(new RegExp('var\\((--buddy-[a-z0-9-]+),\\s*(?:[^()]|\\([^()]*\\))*\\)','g'),'var($1)');
 out=out.replace(/\{;+/g,'{').replace(/;;+/g,';');
 if(unknown.size)console.error(file,'unmapped:',[...unknown].join(', '));
 if(write&&out!==text)writeFileSync(file,out);console.error((out===text?'unchanged ':'updated ')+file);
}
