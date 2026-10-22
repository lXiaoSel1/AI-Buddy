import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function checkReleaseVersion(root){
 const read=p=>readFileSync(join(root,p),'utf8');
 const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json')),v=pkg.version;
 const semver=value=>typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value);
 if(!semver(v))throw Error('Invalid release version');
 if(lock.version!==v||lock.packages?.['']?.version!==v)throw Error('package-lock.json version differs from package.json');
 let state=null;
 if(existsSync(join(root,'release.json'))){
  state=JSON.parse(read('release.json'));
  if(!state||Array.isArray(state)||state.schemaVersion!==1||state.version!==v||!['approved','published'].includes(state.stage)||!semver(state.publishedVersion)||!semver(state.resourceBaseVersion)||!semver(state.installerVersion))throw Error('Invalid release.json state or source version');
  const compare=(a,b)=>{const left=a.split('.').map(Number),right=b.split('.').map(Number);for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]>right[i]?1:-1;}return 0;};
  if(compare(state.publishedVersion,v)>0||compare(state.resourceBaseVersion,v)>0||compare(state.installerVersion,v)>0)throw Error('Release metadata references a future version');
  if(state.stage==='published'&&state.publishedVersion!==v)throw Error('Published source must match publishedVersion');
 }
 const publishedVersion=state?.publishedVersion??v;
 for(const file of ['README.md','README.en.md']){
  const text=read(file),downloads=[...text.matchAll(/AI-Buddy-(\d+\.\d+\.\d+)-Windows-x64(?:-(?:30|60)fps)?\.zip/g)].map(m=>m[1]);
  if(state){
   const markers=[...text.matchAll(/<!--\s*ai-buddy-source-version:\s*([^\s]+)\s*-->/g)].map(m=>m[1]);
   if(markers.length!==1||markers[0]!==v)throw Error(file+' source-version marker differs from package.json');
   downloads.push(...[...text.matchAll(/AI-Buddy-Setup-(\d+\.\d+\.\d+)-win-x64\.exe/g)].map(m=>m[1]));
   const urls=[...text.matchAll(/https:\/\/github\.com\/lXiaoSel1\/ai-buddy\/releases\/download\/v(\d+\.\d+\.\d+)\//gi)].map(m=>m[1]);
   if(urls.some(version=>version!==publishedVersion))throw Error(file+' download URL differs from publishedVersion');
   if(state.stage!=='published'&&v!==publishedVersion&&new RegExp('https://github\\.com/lXiaoSel1/ai-buddy/releases/tag/v'+v.replaceAll('.','\\.')+'(?=[)\\s/#?]|$)','i').test(text))throw Error(file+' links to an unpublished source release');
  }
  if(!downloads.length||downloads.some(n=>n!==publishedVersion))throw Error(file+' download version differs from '+(state?'publishedVersion':'package.json'));
  if(!text.includes(`[v${publishedVersion}](https://github.com/lXiaoSel1/ai-buddy/releases/tag/v${publishedVersion})`))throw Error(file+' is missing the current published release link');
 }
 if(!read('docs/BUILD.md').includes('formal '+v+' binary'))throw Error('Build guide version differs from package.json');
 return state?{ok:true,version:v,stage:state.stage,publishedVersion,resourceBaseVersion:state.resourceBaseVersion,installerVersion:state.installerVersion}:{ok:true,version:v};
}
export function checkResourceVersion(sourceVersion,resourceVersion,releaseState){
 if(releaseState?.version!==sourceVersion)throw Error('Resource compatibility state does not match source');
 if(resourceVersion!==sourceVersion&&resourceVersion!==releaseState.resourceBaseVersion)throw Error('Resource release version does not match source or declared resourceBaseVersion');
 return {sourceVersion,resourceVersion,reused:resourceVersion!==sourceVersion};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(checkReleaseVersion(resolve(import.meta.dirname,'..'))));
