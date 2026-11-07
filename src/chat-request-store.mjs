import {mkdir,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';

const valid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
const transientStatuses=new Set(['queued','generating','completed-unpresented']);
function retainObservation(previous,row){
  if(!previous)return row;
  if(previous.voicePresentation)row={...row,voicePresentation:previous.voicePresentation};
  const observed=previous.observedResult!==undefined,incoming=row.observedResult!==undefined;
  if(observed||incoming)for(const key of ['requestId','characterId','personaId','conversationId','groupId','roundId','lifeId','operationId'])if(previous[key]!==undefined&&row[key]!==undefined&&!isDeepStrictEqual(previous[key],row[key]))throw Object.assign(Error('Chat observation identity conflicts with the original request'),{code:'CHAT_OBSERVATION_CONFLICT'});
  if(!observed)return row;
  if(incoming&&!isDeepStrictEqual(previous.observedResult,row.observedResult))throw Object.assign(Error('Chat observation conflicts with the complete original result'),{code:'CHAT_OBSERVATION_CONFLICT'});
  // Stale streaming writes are delivery progress, never permission to replace
  // an already observed result. Cancellation may change delivery state only.
  if(transientStatuses.has(row.status))return structuredClone(previous);
  return {...previous,...row,observedResult:structuredClone(previous.observedResult),observedAt:previous.observedAt};
}

// Draft journals are deliberately separate from relationship/companion snapshots.
// A restarted request is never automatically resubmitted or counted as lived.
export async function openChatRequestStore(dataRoot,{rename:replace=rename,platform=process.platform,sleep=delay}={}){
  const directory=join(dataRoot,'chat-requests');await mkdir(directory,{recursive:true});const rows=new Map();let tail=Promise.resolve();
  const save=async row=>{
    const target=join(directory,row.requestId+'.json'),temporary=target+'.'+randomUUID()+'.partial';
    try {
      await writeFile(temporary,JSON.stringify(row),{flag:'wx'});
      // Windows readers/scanners can briefly hold the destination without delete
      // sharing. Retry only this rename of these exact completed bytes. Never
      // remove the destination, resubmit a request, or mark an unknown turn done.
      const waits=[50,100,250,500,1000,2000],deadline=Date.now()+4000;
      for(let attempt=0;;attempt++){
        try {await replace(temporary,target);break;}
        catch(error){const wait=waits[attempt];if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||wait===undefined||Date.now()+wait>deadline)throw error;await sleep(wait);if(Date.now()>=deadline)throw error;}
      }
    } finally {await rm(temporary,{force:true}).catch(()=>{});}
  };
  for(const name of await readdir(directory)){if(!name.endsWith('.json')||!valid(name.slice(0,-5)))continue;const row=JSON.parse(await readFile(join(directory,name),'utf8'));if(row.version!==1||row.requestId!==name.slice(0,-5))throw Error('Invalid chat request journal');if(['queued','generating','completed-unpresented'].includes(row.status)){row.status='interrupted';row.error='请求因重启中断；未自动重试';await save(row);}rows.set(row.requestId,row);}
  return {get:id=>rows.has(id)?structuredClone(rows.get(id)):null,list:()=>[...rows.values()].map(row=>structuredClone(row)),async put(value){if(!valid(value.requestId))throw Error('Invalid chat request id');const requested={version:1,...structuredClone(value)};const work=tail.then(async()=>{const row=retainObservation(rows.get(requested.requestId),requested);await save(row);rows.set(row.requestId,row);return structuredClone(row);});tail=work.catch(()=>{});return work;},
  async recordVoicePresentation(scope,receipt){
    const work=tail.then(async()=>{
      const previous=rows.get(scope.requestId);
      if(!previous||['characterId','personaId','lifeId','operationId'].some(key=>previous[key]!==scope[key])||
        (previous.groupId??previous.conversationId)!==scope.conversationId)return false;
      const existing=previous.voicePresentation??[];
      if(existing.some(row=>row.segmentId===receipt.segmentId&&row.status===receipt.status))return true;
      const row={...previous,voicePresentation:[...existing,structuredClone(receipt)]};
      await save(row);rows.set(row.requestId,row);return true;
    });
    tail=work.catch(()=>{});
    return work;
  },
  async flush(){await tail;}};
}
