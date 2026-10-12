import {createServer,connect} from 'node:net';

// One JSONL request per connection. A client may finish sending while it waits
// for an asynchronous response, or disappear before that response is ready.
export function createLocalControlServer({onRequest,onSocketError=()=>{},maxRequestBytes=65536}) {
  return createServer({allowHalfOpen:true},socket=>{
    let input='',handled=false;
    socket.setEncoding('utf8');
    socket.on('error',error=>onSocketError(error));
    socket.setTimeout(30000,()=>socket.destroy());
    const reply=value=>{
      if(socket.destroyed||!socket.writable||socket.writableEnded)return;
      let body;
      try{body=JSON.stringify(value)+'\n';}catch(error){body=JSON.stringify({error:error.message})+'\n';}
      // Write failures can be emitted later, after end() has returned. The
      // socket's error listener remains installed for its entire lifetime.
      try{socket.end(body);}catch(error){onSocketError(error);socket.destroy();}
    };
    socket.on('data',chunk=>{
      if(handled)return;
      input+=chunk;
      if(Buffer.byteLength(input,'utf8')>maxRequestBytes){handled=true;reply({error:'Local request too large'});return;}
      const newline=input.indexOf('\n');if(newline<0)return;
      handled=true;let request;
      try{request=JSON.parse(input.slice(0,newline));if(!request||typeof request!=='object'||Array.isArray(request)||typeof request.command!=='string')throw new Error('Invalid request');}
      catch{reply({error:'Invalid local request'});return;}
      void Promise.resolve().then(()=>onRequest(request)).then(reply,error=>reply({error:String(error?.message || error || 'Local request failed')}));
    });
    socket.on('end',()=>{if(!handled){handled=true;reply({error:'Incomplete local request'});}});
  });
}

export function requestLocalControl(pipe,request,{timeoutMs=5000}={}) {
  return new Promise((resolve,reject)=>{
    let response='',settled=false;
    const socket=connect(pipe);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Local pipe timeout')),timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error',error=>finish(error));
    socket.on('connect',()=>{try{socket.write(JSON.stringify(request)+'\n');}catch(error){finish(error);}});
    socket.on('data',chunk=>response+=chunk);
    socket.on('end',()=>{try{finish(null,JSON.parse(response));}catch(error){finish(error);}});
    socket.on('close',()=>{if(!settled)finish(new Error('Local pipe closed before a complete response'));});
  });
}
