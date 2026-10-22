import {readFileSync,statSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {PET_CHARACTERS} from './pet-characters.mjs';
import {resolveInstallation} from './installation-record.mjs';
export function createInstalledResources({root,build,installation:effectiveInstallation}){
 const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
 const installation=effectiveInstallation===undefined?resolveInstallation({root,build}).installation:effectiveInstallation;
 const index=read(join(build,'assets/install-resource-index.json'));
 if(!index||index.version!==1)throw Error('安装资源索引缺失；请运行安装器修复 / Resource index missing; run installer repair');
 const under=(base,path)=>{if(typeof path!=='string'||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid resource path');const full=resolve(base,path);if(!full.startsWith(resolve(base)+sep))throw Error('Invalid resource path');return full;};
 const valid=file=>{try{const info=statSync(under(build,file.path));return info.isFile()&&info.size===file.bytes;}catch{return false;}};
 let cached=null;
 function status(refresh=false){
  if(cached&&!refresh)return cached;
  const manifest=installation?.manifestSha256&&read(join(root,'local/install-manifests',installation.manifestSha256+'.json'));
  const characters=PET_CHARACTERS.map(c=>{
   const files=index.characters[c.id]??[],missing=files.filter(f=>!valid(f)).map(f=>f.path);
   const recorded=!installation||installation.characters?.includes(c.id);
   const packages=manifest?.packages?.filter(p=>p.characterId===c.id&&(!p.edition||p.edition===index.edition))??[];
   return {...c,installed:recorded&&files.length>0&&missing.length===0,missing:!recorded?['not-selected']:missing,downloadBytes:packages.length?packages.reduce((n,p)=>n+p.bytes,0):null};
  });
  const missingShared=(index.shared??[]).filter(f=>!valid(f)).map(f=>f.path);
  return cached={version:index.appVersion,edition:index.edition,characters,missingDependencies:missingShared,managerAvailable:!!installation?.manager&&existsSync(under(root,installation.manager)),initialCharacter:installation?.initialCharacter??index.defaultCharacter??'deepseek',legacy:!installation};
 }
 function available(id){return status().missingDependencies.length===0&&status().characters.some(c=>c.id===id&&c.installed);}
 function fallback(preferred){if(available(preferred))return preferred;const s=status();return [s.initialCharacter,'deepseek',...s.characters.map(c=>c.id)].find(available)??null;}
 function requireCharacters(ids){const missing=[...new Set(ids)].filter(id=>!available(id));if(missing.length){const error=Error('角色资源待安装：'+missing.join('、')+' / Character resources need installation');error.code='CHARACTER_NOT_INSTALLED';error.characterIds=missing;throw error;}}
 return {status,available,fallback,require:requireCharacters,manager:()=>installation?.manager?under(root,installation.manager):null,installation};
}
