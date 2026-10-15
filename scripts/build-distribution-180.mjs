// Builds application code while copying the approved 1.7.10 media byte-for-byte.
import {build} from 'esbuild';
import {cpSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildPortableLauncher} from './build-portable-launcher.mjs';
const repo=resolve(import.meta.dirname,'..'),arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const baseline30=resolve(arg('baseline30')??''),baseline60=resolve(arg('baseline60')??''),out=resolve(arg('out')??''),rcedit=resolve(arg('rcedit')??'');
if(!arg('out')||!arg('baseline30')||!arg('baseline60')||!arg('rcedit'))throw Error('Supply --baseline30, --baseline60, --out, --rcedit');
if(JSON.parse(readFileSync(join(repo,'package.json'))).version!=='1.8.0')throw Error('Source must be 1.8.0');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
function owner(path){const match=path.match(/^assets\/(?:pet-characters\/([^/]+)|characters\/v\d+\/([^/]+))/);if(match)return (match[1]||match[2])==='gpt'?'chatgpt':match[1]||match[2];if(path==='assets/maid-left.webp'||path==='assets/cg-references/maid-left.png')return 'deepseek';const ref=path.match(/^assets\/cg-references\/(claude|gemini|gpt|grok|kimi)-/);if(ref)return ref[1]==='gpt'?'chatgpt':ref[1];return null;}
const proof=[];mkdirSync(out,{recursive:true});
for(const [fps,source] of [[30,baseline30],[60,baseline60]]) {
 const pointer=read(join(source,'local/current-build.json')),base=resolve(source,pointer.path);
 if(read(join(base,'package.json')).version!=='1.7.10')throw Error('Wrong baseline');
 const receipt=read(join(source,'manifest.json'));let verified=0;
 for(const f of receipt.files){const file=join(source,f.path);if(statSync(file).size!==f.bytes||hash(file)!==f.sha256)throw Error('Baseline hash mismatch '+f.path);verified++;}
 const dest=join(out,fps+'fps','build');mkdirSync(dest,{recursive:true});cpSync(join(base,'assets'),join(dest,'assets'),{recursive:true});
 const sequences=read(join(base,'assets/frame-sequence-manifest.json')),characters=read(join(base,'assets/character-sequence-manifest.json')),previews=read(join(base,'assets/gallery-preview-manifest.json'));
 const shared={bundle:true,logLevel:'info',legalComments:'eof'};
 for(const entry of ['main','preload','monitor-worker'])await build({...shared,entryPoints:[join(repo,'src',entry+'.mjs')],outfile:join(dest,entry+'.cjs'),platform:'node',target:'node24',format:'cjs',external:['electron'],define:entry==='main'?{'__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PET_CHARACTER_SEQUENCES__':JSON.stringify(characters)}:undefined});
 for(const entry of ['dashboard','pet'])await build({...shared,entryPoints:[join(repo,'src',entry+'.mjs')],outfile:join(dest,entry+'.js'),platform:'browser',target:'chrome144',format:'iife',define:{'process.env.NODE_ENV':'"production"','__ALL_ACTION_RIGS__':'false','__FIVE_ACTIONS_V014__':'false','__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PET_CHARACTER_SEQUENCES__':JSON.stringify(characters),'__PREVIEW_ATLASES__':JSON.stringify(entry==='dashboard'?previews.resources:{})}});
 for(const name of ['index.html','pet.html','dashboard.css','appearance.css'])copyFileSync(join(repo,'src',name),join(dest,name));
 writeFileSync(join(dest,'package.json'),JSON.stringify({name:'ai-buddy',productName:'AI Buddy',version:'1.8.0',animationProfile:fps+'fps',main:'main.cjs'}));
 const resourceIndex={version:1,appVersion:'1.8.0',edition:fps+'fps',defaultCharacter:'deepseek',shared:[],characters:Object.fromEntries(Object.keys(characters).map(id=>[id,[]]))};
 let media=0;
 for(const p of files(join(dest,'assets'))){const path=relative(dest,p).replaceAll('\\','/');if(path==='assets/install-resource-index.json')continue;const id=owner(path);const item={path,bytes:statSync(p).size,sha256:hash(p)};(id?resourceIndex.characters[id]:resourceIndex.shared).push(item);if(/\.(webm|png|webp)$/i.test(path)){if(item.sha256!==hash(join(base,path)))throw Error('Media changed '+path);media++;}}
 for(const id of Object.keys(characters))if(resourceIndex.characters[id].filter(f=>f.path.endsWith('.webm')).length!==18)throw Error(id+' does not have 18 distinct videos');
 writeFileSync(join(dest,'assets/install-resource-index.json'),JSON.stringify(resourceIndex));
 proof.push({edition:fps+'fps',baseline:source,verifiedBaselineFiles:verified,unchangedMediaFiles:media,resourceIndexSha256:hash(join(dest,'assets/install-resource-index.json'))});
 if(fps===30) {
  const runtime=join(out,'runtime');cpSync(resolve(source,pointer.runtime.path),runtime,{recursive:true});
  if(hash(rcedit)!=='3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a')throw Error('Untrusted rcedit');
  const executable=join(runtime,'AI Buddy.exe');const result=spawnSync(rcedit,[executable,'--set-file-version','1.8.0','--set-product-version','1.8.0'],{windowsHide:true,encoding:'utf8'});if(result.status!==0)throw Error(result.stderr||result.stdout);
  writeFileSync(join(runtime,'resources/app/package.json'),JSON.stringify({name:'ai-buddy',version:'1.8.0',main:'main.cjs'}));
  writeFileSync(join(runtime,'resources/app/build.json'),JSON.stringify({appVersion:'1.8.0',version:'1.8.0',path:'builds/v1.8.0'}));
  // Both frame-rate editions resolve through the committed root pointer.
  writeFileSync(join(runtime,'resources/app/main.cjs'),`const fs=require('node:fs'),path=require('node:path');const root=path.resolve(__dirname,'../../../..');const p=JSON.parse(fs.readFileSync(path.join(root,'local/current-build.json'),'utf8'));const target=path.resolve(root,p.path);if(!target.startsWith(root+path.sep))throw Error('Invalid build path');require('electron').app.setAppPath(target);require(path.join(target,'main.cjs'));`);
  const runtimeReceipt={version:'1.8.0',upstream:'Electron 44.6.0',baselineRuntimeSha256:pointer.runtime.sha256,rceditSha256:hash(rcedit),files:files(runtime).filter(p=>!p.endsWith('runtime-manifest.json')).map(p=>({path:relative(runtime,p).replaceAll('\\','/'),sha256:hash(p)}))};writeFileSync(join(runtime,'runtime-manifest.json'),JSON.stringify(runtimeReceipt,null,2));
 }
}
const entry=join(out,'root');mkdirSync(entry,{recursive:true});
for(const path of ['AI Buddy.cmd','AI Buddy.vbs','Start-AI-Buddy.ps1','LICENSE.md','README.md','README.en.md','THIRD_PARTY_NOTICES.md','THIRD_PARTY_MONITOR.md','licenses','docs','assets/branding'])if(existsSync(join(repo,path)))cpSync(join(repo,path),join(entry,path),{recursive:true});
buildPortableLauncher(repo,join(entry,'AI Buddy.exe'),'1.8.0');
writeFileSync(join(out,'media-proof.json'),JSON.stringify({ok:true,reencoded:0,proof},null,2));
console.log(JSON.stringify({ok:true,out,proof}));
