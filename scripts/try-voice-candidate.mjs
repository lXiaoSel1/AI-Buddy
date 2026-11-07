import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';
import {requestLocalControl} from '../src/local-control.mjs';

const [mode,workspaceArgument]=process.argv.slice(2);
const workspace=resolve(workspaceArgument??join(import.meta.dirname,'../..'));
if(!['install','prepare','launch','quit'].includes(mode)||!workspace.endsWith('voice18r1'))throw Error('Only the explicitly isolated voice18r1 candidate is supported');
const source=join(workspace,'source'),artifact=join(workspace,'builds','formal-voice-plugins-20261107-r1');
const build=join(source,'builds','formal-voice-host-20261107-r1'),dataRoot=join(workspace,'test-data','formal-host-profile');
const certificate=join(workspace,'runtimes','candidate-tls-cert.pem'),key=join(workspace,'runtimes','candidate-tls-key.pem');
const receipt=JSON.parse(await readFile(join(artifact,'RECEIPT.json'),'utf8'));
if(!receipt.candidateOnly)throw Error('Expected isolated candidate signing identity');
if(process.env.NODE_EXTRA_CA_CERTS!==certificate){
  const child=spawnSync(process.execPath,[import.meta.filename,mode,workspace],{windowsHide:true,stdio:'inherit',env:{...process.env,NODE_EXTRA_CA_CERTS:certificate}});
  process.exit(child.status??1);
}
await mkdir(dataRoot,{recursive:true});
const ids=['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'];
if(mode==='quit'){
  const pipe='\\\\.\\pipe\\ai-buddy-voice18r1-formal';
  const status=await requestLocalControl(pipe,{command:'installation-status'});
  if(status.build!==build||status.dataRoot!==dataRoot)throw Error('Refusing to affect a different installation');
  console.log(JSON.stringify(await requestLocalControl(pipe,{command:'installation-quit',expectedBuild:build})));
}else if(mode==='launch'){
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',join(workspace,'receipts','Start-Voice-Candidate.ps1')],{windowsHide:true,stdio:'inherit',env:process.env});
  process.exit(result.status??1);
}else{
  let server;
  if(mode==='install'){
    const log=await open(join(workspace,'receipts','FORMAL-PLUGIN-SOURCE.log'),'a');
    server=spawn(process.execPath,[join(source,'scripts','serve-voice-candidates.mjs'),artifact,certificate,key],{cwd:source,windowsHide:true,stdio:['ignore',log.fd,log.fd]});await log.close();
    let ready=false;
    for(let n=0;n<50;n++){try{const response=await fetch(receipt.sourceUrl);if(response.ok){ready=true;break;}}catch{}await delay(100);}
    if(!ready){server.kill();throw Error('Candidate HTTPS source did not become ready');}
  }
  const manager=await createPluginManager({root:source,dataRoot,appVersion:'2.0.7',voiceTestFingerprint:receipt.fingerprint});
  // Plain Node installs/verifies the final ZIP. Native JS activation belongs to
  // the actual Electron candidate, where utilityProcess is available.
  const authority=createVoicePackageAuthority({manager,voiceTestFingerprint:receipt.fingerprint});
  try{
    if(mode==='install'){
      for(const item of Object.values(receipt.packages)){
        const bytes=await readFile(join(artifact,item.path));if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Final artifact changed');
      }
      let existing=manager.snapshot().sources?.find(row=>row.keyFingerprint===receipt.fingerprint);
      if(!existing){const preview=await authority.action({action:'sources-preview',url:receipt.sourceUrl});await authority.action({action:'sources-add',previewId:preview.previewId,keyFingerprint:preview.source.keyFingerprint});existing=preview.source;}
      const sourceId=existing.sourceId;
      if(ids.some(id=>manager.snapshot().installed[id]?.current!=='1.0.0')){
        const plan=await authority.action({action:'plan',sourceId,requests:ids.map(id=>({id,version:'1.0.0'}))});
        await authority.action({action:'install',planId:plan.planId});
      }
      for(const id of ids)await authority.action({action:'enable',id,sourceId});
      const installed=[];
      for(const id of ids)for(const provider of ['local','minimax']){const row=await authority.resolveVoicePackage(id,{provider});installed.push({id,provider,version:row.version,sourceId:row.sourceId,archiveSha256:row.archiveSha256,sharedDirectory:row.shared.directory});}
      if(new Set(installed.map(row=>row.sharedDirectory)).size!==1)throw Error('Shared dependency duplicated');
      const evidence={testType:'real final ZIP installation, localhost HTTPS and signed transactions; native JS activation/model/audio/UI pending',candidateOnly:true,sourceId,installed,status:authority.status()};
      await writeFile(join(workspace,'receipts','FINAL-PLUGIN-INSTALLATION.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
    }else{
      const assets=createVoiceAssets({dataRoot,resolveVoicePackage:(...args)=>authority.resolveVoicePackage(...args)}),prepared=[];
      for(const kind of ['asr','breeze','gpt']){
        const id=kind==='gpt'?ids[1]:ids[0];console.log('Preparing '+kind);
        const result=await assets.prepare(kind,{engineId:id,localRoot:join(workspace,'runtimes','offline-components',kind)});
        prepared.push({kind,...result});
        await writeFile(join(workspace,'receipts','FORMAL-COMPONENT-PREPARATION.json'),JSON.stringify({candidateOnly:true,prepared},null,2));console.log(JSON.stringify({kind,...result}));
      }
    }
  }finally{try{await authority.close();}finally{try{await manager.close();}finally{server?.kill();}}}
}
