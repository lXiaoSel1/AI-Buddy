import {build} from 'esbuild';
import {existsSync,readFileSync,mkdirSync,readdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {checkReleaseVersion} from './check-release-version.mjs';
const root=resolve(import.meta.dirname,'..'),resources=process.argv.find(a=>a.startsWith('--resources='))?.slice(12);
checkReleaseVersion(root);
if(!resources)throw Error('Pass --resources=<build folder from the matching portable release>');
const source=resolve(resources),out=join(root,'builds/development');
if(!existsSync(join(source,'assets/frame-sequence-manifest.json')))throw Error('Resource manifest missing');
const portraitProof=JSON.parse(readFileSync(join(root,'assets/cg-references/maid-left.source.json'),'utf8'));
for(const [file,expected] of [[portraitProof.source,portraitProof.sourceSha256],['assets/cg-references/maid-left.png',portraitProof.pngSha256]]){
 if(!existsSync(join(source,file))||createHash('sha256').update(readFileSync(join(source,file))).digest('hex')!==expected)throw Error('CG portrait reference does not match this source release: '+file+'. Use the matching portable release resources.');
}
const sequences=JSON.parse(readFileSync(join(source,'assets/frame-sequence-manifest.json'),'utf8')),previews=JSON.parse(readFileSync(join(source,'assets/gallery-preview-manifest.json'),'utf8'));
// Copy one file at a time: Node 24's recursive cpSync can abort on long
// Windows resource paths containing non-ASCII characters.
function copyAssets(from,to){
 mkdirSync(to,{recursive:true});
 for(const entry of readdirSync(from,{withFileTypes:true})){
  const input=join(from,entry.name),output=join(to,entry.name);
  if(entry.isDirectory())copyAssets(input,output);
  else if(entry.isFile())copyFileSync(input,output);
  else throw Error('Unsupported resource entry: '+input);
 }
}
mkdirSync(out,{recursive:true});copyAssets(join(source,'assets'),join(out,'assets'));
const shared={bundle:true,logLevel:'info',legalComments:'eof'};
for(const entry of ['main','preload','monitor-worker'])await build({...shared,entryPoints:[join(root,'src',entry+'.mjs')],outfile:join(out,entry+'.cjs'),platform:'node',target:'node24',format:'cjs',external:['electron'],define:entry==='main'?{'__FRAME_SEQUENCES__':JSON.stringify(sequences)}:undefined});
for(const entry of ['dashboard','pet'])await build({...shared,entryPoints:[join(root,'src',entry+'.mjs')],outfile:join(out,entry+'.js'),platform:'browser',target:'chrome144',format:'iife',define:{'process.env.NODE_ENV':'"production"','__ALL_ACTION_RIGS__':'false','__FIVE_ACTIONS_V014__':'false','__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PREVIEW_ATLASES__':JSON.stringify(entry==='dashboard'?previews.resources:{})}});
for(const name of ['index.html','pet.html','dashboard.css','appearance.css'])copyFileSync(join(root,'src',name),join(out,name));
writeFileSync(join(out,'package.json'),JSON.stringify({name:'ai-buddy',productName:'AI Buddy',version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,main:'main.cjs'}));
console.log('Built '+out);
