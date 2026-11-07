import {updateError} from './update-reservation.mjs';

// Both routes bind stdout to this exact child and nonce before accepting progress or results.
export function readUpdateWorker(child,{command,nonce,signal,onProgress=()=>{},validateReady,initial}){
    return new Promise((resolveRun,reject)=>{
      let ready=false,settled=false,result=null,buffer='';
      const deadline=setTimeout(()=>finish(updateError('APP_UPDATE_BACKEND_TIMEOUT')),command==='prepare'?60*60_000:command==='apply'?16*60_000:120_000);
      const startup=setTimeout(()=>finish(updateError('APP_UPDATE_BACKEND_TIMEOUT')),15_000);
      const cancel=()=>{if(child.stdin.writable)child.stdin.write(JSON.stringify({command:'cancel',nonce})+'\n');};
      function finish(error){
        if(settled)return;
        settled=true;clearTimeout(deadline);clearTimeout(startup);signal?.removeEventListener('abort',cancel);
        if(error){cancel();child.stdin.end();child.stdout.destroy();child.unref();reject(error);}else resolveRun(result);
      }
      child.stdin.on('error',()=>{});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if(settled)return;
        buffer+=chunk;
        let newline;
        while((newline=buffer.indexOf('\n'))>=0){
          if(newline>65536)return finish(updateError('APP_UPDATE_PROTOCOL'));
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
          let event;
          try{event=JSON.parse(line);}catch{return finish(updateError('APP_UPDATE_PROTOCOL'));}
          if(event?.protocol!==1||event.nonce!==nonce||event.processId!==child.pid||result)return finish(updateError('APP_UPDATE_PROTOCOL'));
          if(!ready){
            if(event.type==='result'&&event.ok===false){result=event;continue;}
            if(event.type!=='ready'||!validateReady(event))return finish(updateError('APP_UPDATE_PROTOCOL'));
            ready=true;clearTimeout(startup);
          }
          else if(event.type==='progress')onProgress(event);
          else if(event.type==='result')result=event;
          else return finish(updateError('APP_UPDATE_PROTOCOL'));
        }
        if(buffer.length>65536)finish(updateError('APP_UPDATE_PROTOCOL'));
      });
      child.once('error',()=>finish(updateError('APP_UPDATE_BACKEND_START')));
      child.once('close',code=>finish(result&&(ready||result.ok===false)&&!buffer.trim()&&((code===0)===(result.ok===true))?null:updateError('APP_UPDATE_BACKEND_EXIT')));
      signal?.addEventListener('abort',cancel,{once:true});
      if(initial)child.stdin.write(JSON.stringify(initial)+'\n');
      if(signal?.aborted)cancel();
    });
}
