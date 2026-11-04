import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {APPROVED_GAME_RULE_HASHES} from './trusted-rules.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),fail=code=>Object.assign(Error(code),{code});
/** Exact archive bytes, not a renderer-supplied path, provide the host's rules. */
export async function importVerifiedGameRules({archivePath,archiveSha256,cacheRoot}){
 const bytes=await readFile(archivePath);if(sha(bytes)!==archiveSha256)throw fail('GAME_RULE_PACKAGE_HASH');const tar=gunzipSync(bytes,{maxOutputLength:64*1024*1024}),seen=new Set();let rules,manifest;
 for(let offset=0;offset+512<=tar.length;){const h=tar.subarray(offset,offset+512);if(h.every(v=>v===0))break;const str=(a,b)=>h.toString('utf8',a,b).replace(/\0.*$/s,''),name=(str(345,500)?str(345,500)+'/':'')+str(0,100);if(!name.startsWith('package/')||name.includes('\\')||name.split('/').some(p=>p==='.'||p==='..')||seen.has(name.toLowerCase()))throw fail('GAME_RULE_ARCHIVE_INVALID');seen.add(name.toLowerCase());const raw=str(124,136).trim();if(!/^[0-7]+$/.test(raw))throw fail('GAME_RULE_ARCHIVE_INVALID');const size=parseInt(raw,8),start=offset+512;if(!Number.isSafeInteger(size)||size<0||start+size>tar.length||!['\0','0'].includes(h.toString('ascii',156,157)))throw fail('GAME_RULE_ARCHIVE_INVALID');const body=tar.subarray(start,start+size);if(name==='package/lib/rules.js')rules=Buffer.from(body);if(name==='package/package.json')manifest=JSON.parse(body.toString('utf8'));offset=start+Math.ceil(size/512)*512;}
 if(!rules||manifest?.name!=='@ai-buddy/card-games')throw fail('GAME_RULE_MODULE_MISSING');const hash=sha(rules);if(!APPROVED_GAME_RULE_HASHES.includes(hash))throw fail('GAME_RULE_MODULE_NOT_APPROVED');await mkdir(cacheRoot,{recursive:true});const path=join(cacheRoot,hash+'.mjs');try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||sha(await readFile(path))!==hash)throw fail('GAME_RULE_CACHE_CHANGED');}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(path,rules,{flag:'wx'});}
 const module=await import(pathToFileURL(path).href);for(const method of ['createGame','reduceGame','projectGame','replayGame','legalActions'])if(typeof module[method]!=='function')throw fail('GAME_RULE_MODULE_INVALID');if(!module.STANDARD_DECK||!module.RULE_MANIFEST)throw fail('GAME_RULE_MODULE_INVALID');return {module,sha256:hash,packageDigest:archiveSha256,version:manifest.version};
}
