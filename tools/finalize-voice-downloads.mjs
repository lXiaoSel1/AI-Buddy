import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,basename,resolve,relative,isAbsolute,sep} from 'node:path';
import {parseVoiceAssetDownloads,voiceAssetDownloadUrl} from '../src/voice/asset-downloads.mjs';

// Release staging only. The caller supplies the real, approved asset location;
// this tool neither publishes it nor claims that the URL has been checked.
const option=name=>process.argv.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3);
const resources=option('resources'),plugins=option('plugins'),output=option('out'),location=option('base-url');
if(!resources||!plugins||!output||!location)throw Error('Required: --resources= --plugins= --out= --base-url=');
const base=voiceAssetDownloadUrl(location.replace(/\/$/,'')+'/');
if(base.search)throw Error('Resource base URL cannot include a query');
const root=resolve(resources),destination=resolve(output);
const contains=(a,b)=>{const path=relative(a,b);return !path||!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);};
if(contains(root,destination)||contains(destination,root))throw Error('Output must be disjoint from immutable resources');
await mkdir(destination);
const receipts=[];
for(const [kind,name]of [['asr','voice-shared-runtime'],['breeze','voice-breeze'],['gpt','voice-gpt-sovits']]){
 const raw=await readFile(join(plugins,name,'assets.json')),descriptor=JSON.parse(raw),descriptorHash=createHash('sha256').update(raw).digest('hex');
 if(descriptor.kind!==kind)throw Error('Resource inventory kind mismatch');
 const template=JSON.parse(await readFile(join(root,kind,'downloads.template.json'),'utf8'));
 const archives=[];
 for(const {assetName,...entry}of template.archives){
  if(entry.format==='pinned-ffmpeg-zip'){if(assetName!==undefined)throw Error('The pinned upstream archive must not be mirrored');archives.push(entry);continue;}
  if(typeof assetName!=='string'||basename(assetName)!==assetName||!/^voice-(asr|breeze|gpt)-runtime-\d{3}\.zip$/.test(assetName))throw Error('Invalid delivery asset name');
  const archive=join(root,kind,assetName),info=await stat(archive);if(!info.isFile()||info.size!==entry.bytes)throw Error('Resource archive size mismatch');
  const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
  if(hash.digest('hex')!==entry.sha256)throw Error('Resource archive hash mismatch');
  archives.push({...entry,url:new URL(assetName,base).href});
 }
 const metadata={...template,archives};parseVoiceAssetDownloads(JSON.stringify(metadata),{descriptor,descriptorHash});
 await mkdir(join(destination,name));const bytes=Buffer.from(JSON.stringify(metadata)+'\n');
 await writeFile(join(destination,name,'downloads.json'),bytes,{flag:'wx'});
 receipts.push({kind,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),assetsSha256:descriptorHash});
}
await writeFile(join(destination,'DELIVERY-METADATA.json'),JSON.stringify({schemaVersion:1,files:receipts,publicUrlsVerified:false,signed:false,published:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:destination,components:receipts.length,signed:false,published:false}));
