import {generateKeyPairSync, sign} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {assertPluginTreeNoLinks} from '../src/plugin-archive.mjs';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {pluginSourceFingerprint} from '../src/plugin-sources.mjs';
import {VOICE_CLOUD_WORKER, VOICE_ENGINES, VOICE_PACKAGE_VERSION, VOICE_PROVIDERS, VOICE_SHARED_PACKAGE} from '../src/voice/package-contract.mjs';
import {packagePlugin} from './package-plugin.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourceName='ai-buddy.voice18r1.candidate';
const candidateKeyId='voice-candidate';
const descriptions={
  'ai-buddy.voice-breeze':{name:'Breeze 语音',description:'选择本地 Breeze 或 MiniMax 云配音。共用本地流式识别、录音、轮流 Live 和播放。',files:['entry.mjs','breeze_worker.py','cadence.py','assets.json']},
  'ai-buddy.voice-gpt-sovits':{name:'GPT-SoVITS 语音',description:'选择本地 GPT-SoVITS V5 Turbo 或 MiniMax 云配音。共用本地流式识别、录音、轮流 Live 和播放。',files:['entry.mjs','gpt_worker.py','assets.json']},
  [VOICE_SHARED_PACKAGE]:{name:'AI Buddy 共享语音运行依赖',description:'两种语音引擎共用的识别、云配音 worker 与运行协议；自动管理的内部依赖。',files:['asr.py','asr_worker.py','worker_protocol.py',VOICE_CLOUD_WORKER,'assets.json']},
};

const assetNotice=`# Voice component licenses and preparation\n\nThe Buddy plugin code license in LICENSE.md does not relicense models, Python, FFmpeg, third-party distributions, user reference recordings, or cloud services. Model weights and Python environments are not embedded in these small ZIPs: signed assets.json fixes every component path, size, SHA-256 and available pinned source. Prepare only the selected local engine plus the one shared runtime. MiniMax mode requires the shared Python/ASR/cloud runtime and an explicitly configured key/voice binding; it does not require Breeze or GPT-SoVITS weights. It never silently falls back to another engine or downloads a second TTS engine.\n\nBreeze source is Apache-2.0. Breeze model materials, derivatives and self-hosted outputs are governed by the BreezeBlue Research and Non-Commercial License v1.1, preserved as checkpoints/LICENSE in the component inventory; commercial use requires a separate written license. The audio tokenizer retains its own license. GPT-SoVITS source is MIT; pretrained models and included dependencies retain their own notices. Python and site-packages retain python/LICENSE.txt and distribution dist-info/licenses. FFmpeg retains the supplying distribution terms and must be reviewed with that distribution before formal redistribution.\n\nUser role reference recordings are private data and are not included in the candidate packages. A local reference profile does not create or promise the same timbre on MiniMax: use the role's explicitly selected MiniMax voice binding. API keys are not included. Hosted service terms are separate from self-hosted model licenses.\n\nThis is an isolated test artifact. Final compatibility, authorized signing and any distribution of model assets are owned by the final integrator.\n`;

function assetSummary(id,bytes) {
  const value=JSON.parse(bytes);
  const kind=id===VOICE_SHARED_PACKAGE?'asr':id==='ai-buddy.voice-breeze'?'breeze':'gpt';
  if(value.schemaVersion!==1 || value.kind!==kind || !Array.isArray(value.files) || !value.files.length ||
     !value.files.some(row=>row.path===value.python) ||
     value.files.some(row=>typeof row.path!=='string' || !Number.isSafeInteger(row.bytes) || row.bytes<0 || !/^[a-f0-9]{64}$/.test(row.sha256)))
    throw Error(`Invalid signed asset inventory for ${id}`);
  if(kind==='asr' && !['httpx','websockets'].every(name=>value.files.some(row=>row.path.startsWith(`python/Lib/site-packages/${name}/`))))
    throw Error('The shared Python inventory must include the controlled MiniMax dependencies');
  return {kind,version:value.version,files:value.files.length,bytes:value.files.reduce((total,row)=>total+row.bytes,0),
    sourceFiles:value.files.filter(row=>row.url).length,executionProfile:value.executionProfile??null,
    licenseNotes:value.licenseNotes??null,providers:id===VOICE_SHARED_PACKAGE?null:VOICE_PROVIDERS,
    cloudRequiresLocalTtsWeights:false};
}

function sshPublicKey(publicKey) {
  const field=value=>{
    const bytes=Buffer.from(value),size=Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size,bytes]);
  };
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  return 'ssh-ed25519 '+Buffer.concat([field('ssh-ed25519'),field(raw)]).toString('base64');
}

export async function packageVoiceCandidates({out,origin}) {
  if(!out || !origin)throw Error('Use --out=<fresh output> --origin=https://127.0.0.1:<port>');
  const endpoint=new URL(origin);
  if(endpoint.protocol!=='https:' || endpoint.hostname!=='127.0.0.1' || !endpoint.port || endpoint.pathname!=='/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw Error('Candidate signing is limited to a fixed loopback HTTPS origin');
  const originUrl=endpoint.origin;
  const output=resolve(out);
  await assertPluginTreeNoLinks(dirname(output));
  const sdkRoot=join(root,'sdk','plugins');
  const assets={};
  for(const [id,spec] of Object.entries(descriptions)){
    const directory=join(sdkRoot,id.slice('ai-buddy.'.length));
    await assertPluginTreeNoLinks(directory);
    await Promise.all(spec.files.map(path=>readFile(join(directory,path))));
    assets[id]=assetSummary(id,await readFile(join(directory,'assets.json')));
  }
  await mkdir(output);
  const writeJson=(file,value)=>writeFile(join(output,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const ssh=sshPublicKey(publicKey),fingerprint=pluginSourceFingerprint(ssh);
  const seal=payload=>({payload,signature:{keyId:candidateKeyId,algorithm:'ed25519',value:sign(null,Buffer.from(canonicalPluginJson(payload)),privateKey).toString('base64')}});
  const records=[];
  const packageFiles={};
  for(const [id,spec] of Object.entries(descriptions)){
    const directoryName=id.slice('ai-buddy.'.length),isRuntime=id===VOICE_SHARED_PACKAGE;
    const staging=join(output,'inputs',directoryName);
    await mkdir(staging,{recursive:true});
    for(const path of spec.files)await copyFile(join(sdkRoot,directoryName,path),join(staging,path));
    await copyFile(join(root,'LICENSE.md'),join(staging,'LICENSE.md'));
    await writeFile(join(staging,'ASSET-NOTICES.md'),assetNotice,{flag:'wx'});
    const manifestPath=join('inputs',`${directoryName}.manifest.json`);
    const manifest={schemaVersion:1,id,name:spec.name,description:spec.description,version:VOICE_PACKAGE_VERSION,
      kind:isRuntime?'runtime':'plugin',appRange:'2.0.7',apiRange:'^1.0.0',platform:'win32',arch:'x64',
      entry:isRuntime?'asr_worker.py':'entry.mjs',activationEvents:isRuntime?[]:[`onCommand:voice.${VOICE_ENGINES[id].engine}`],
      capabilities:isRuntime?[]:['commands.register'],dependencies:isRuntime?{}:{[VOICE_SHARED_PACKAGE]:VOICE_PACKAGE_VERSION},
      category:'voice',license:'Apache-2.0 + Commons Clause',author:'lXiaoSel1'};
    await writeJson(manifestPath,manifest);
    const name=`${id}-${VOICE_PACKAGE_VERSION}.zip`;
    const relativeArchive=`packages/${directoryName}/${name}`;
    const product=await packagePlugin({manifest:join(output,manifestPath),files:staging,out:join(output,'packages',directoryName),url:`${originUrl}/${relativeArchive}`});
    const row=JSON.parse(await readFile(product.entry,'utf8'));
    records.push(row);
    packageFiles[id]={path:relativeArchive,sha256:product.sha256,bytes:product.bytes};
  }
  const generatedAt=new Date().toISOString();
  const descriptor={schemaVersion:1,id:sourceName,name:'AI Buddy 隔离语音候选',catalogUrl:`${originUrl}/catalog.json`,publicKey:ssh,keyId:candidateKeyId};
  const catalog=seal({schemaVersion:1,id:sourceName,generatedAt,packages:records});
  const community=seal({schemaVersion:1,type:'ai-buddy-community-catalog',id:sourceName,generatedAt,source:{descriptorId:sourceName,keyFingerprint:fingerprint},
    authors:[{id:'ai-buddy',name:'AI Buddy',githubLogin:'lXiaoSel1'}],
    works:records.filter(row=>row.manifest.kind==='plugin').map(({manifest,publishedAt})=>({id:manifest.id,backend:'buddy-v1',packageName:manifest.id,
      name:manifest.name,description:manifest.description,authorId:'ai-buddy',category:'voice',status:'published',releases:[{version:manifest.version,publishedAt}]}))});
  await mkdir(join(output,'community'));
  await writeJson('source.json',descriptor);
  await writeJson('catalog.json',catalog);
  await writeJson('community/catalog-v1.json',community);
  await writeJson('ASSET-REPORT.json',{schemaVersion:1,candidateOnly:true,packages:assets});
  await writeFile(join(output,'ASSET-NOTICES.md'),assetNotice,{flag:'wx'});
  const receipt={candidateOnly:true,origin:originUrl,sourceUrl:`${originUrl}/source.json`,communityUrl:`${originUrl}/community/catalog-v1.json`,fingerprint,packages:packageFiles,assets};
  await writeJson('RECEIPT.json',receipt);
  return receipt;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const options=Object.fromEntries(process.argv.slice(2).map(value=>{
    const at=value.indexOf('=');
    if(!value.startsWith('--') || at<3)throw Error('Use --name=value');
    return [value.slice(2,at),value.slice(at+1)];
  }));
  console.log(JSON.stringify(await packageVoiceCandidates(options),null,2));
}
