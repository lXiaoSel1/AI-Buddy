import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function checkReleaseVersion(root){
 const read=p=>readFileSync(join(root,p),'utf8');
 const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json')),v=pkg.version;
 if(!/^\d+\.\d+\.\d+$/.test(v))throw Error('Invalid release version');
 if(lock.version!==v||lock.packages?.['']?.version!==v)throw Error('package-lock.json version differs from package.json');
 for(const file of ['README.md','README.en.md']){
  const text=read(file),downloads=[...text.matchAll(/AI-Buddy-(\d+\.\d+\.\d+)-Windows-x64\.zip/g)].map(m=>m[1]);
  if(!downloads.length||downloads.some(n=>n!==v))throw Error(file+' download version differs from package.json');
  if(!text.includes(`[v${v}](https://github.com/lXiaoSel1/ai-buddy/releases/tag/v${v})`))throw Error(file+' is missing the current release link');
 }
 if(!read('docs/BUILD.md').includes('formal '+v+' binary'))throw Error('Build guide version differs from package.json');
 return {ok:true,version:v};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(checkReleaseVersion(resolve(import.meta.dirname,'..'))));
