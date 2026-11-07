import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assertPluginTreeNoLinks} from '../src/plugin-archive.mjs';

const [directory,certificate,key]=process.argv.slice(2);
if(!directory || !certificate || !key)throw Error('Pass artifact directory, TLS certificate and TLS key');
const root=resolve(directory);
await assertPluginTreeNoLinks(root);
const receipt=JSON.parse(await readFile(join(root,'RECEIPT.json'),'utf8'));
const origin=new URL(receipt.origin);
if(!receipt.candidateOnly || origin.protocol!=='https:' || origin.hostname!=='127.0.0.1' || !origin.port)throw Error('Expected loopback candidate');
const paths=['source.json','catalog.json','community/catalog-v1.json',...Object.values(receipt.packages).map(row=>row.path)];
const entries=new Map();
for(const path of paths){
  if(!/^[a-z0-9./_-]+$/.test(path) || path.split('/').some(part=>part==='.' || part==='..' || part===''))throw Error('Unsafe candidate file');
  const file=join(root,path);
  await assertPluginTreeNoLinks(file);
  entries.set('/'+path,await readFile(file));
}
const server=createServer({cert:await readFile(certificate),key:await readFile(key)},(request,response)=>{
  const bytes=request.method==='GET'?entries.get(request.url):undefined;
  if(!bytes){response.writeHead(404).end();return;}
  response.writeHead(200,{'content-type':request.url.endsWith('.json')?'application/json':'application/zip','content-length':bytes.length});
  response.end(bytes);
});
server.listen(Number(origin.port),'127.0.0.1',()=>console.log(`Voice candidate source ${receipt.sourceUrl}`));
