import {rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

/** Freshly extracted executable directories can briefly deny rename on Windows.
 * Retry that exact operation only, with a four-second default (explicit budgets capped at ten). Never copy, remove
 * a destination, or replay registry/activation operations after an unknown result. */
export async function renamePluginPath(source,target,{platform=process.platform,renameImpl=rename,sleepImpl=delay,now=Date.now,retryBudgetMs=4000}={}){
  if(!Number.isInteger(retryBudgetMs)||retryBudgetMs<0||retryBudgetMs>10000)throw RangeError('Rename retry budget must be integer milliseconds from 0 to 10000');
  const waits=[50,100,250,500,1000,2000,...(retryBudgetMs>4000?[1000,1000,1000,1000,1000,1000]:[])],started=now();
  for(let attempt=0;;attempt++){
    try{return await renameImpl(source,target);}
    catch(error){
      const wait=waits[attempt];
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||wait===undefined||now()-started+wait>retryBudgetMs)throw error;
      await sleepImpl(wait);
      if(now()-started>=retryBudgetMs)throw error;
    }
  }
}
