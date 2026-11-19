import {readFile,mkdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeAtomic} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

const fail=(message,code)=>Object.assign(Error(message),{code});
const providerIds=new Set(['minimax','minimax-cn','minimax-global','cloud-hmac']);
const refProvider=ref=>typeof ref==='string'?/^voice:(minimax|minimax-cn|minimax-global|cloud-hmac):[a-f0-9-]{36}$/.exec(ref)?.[1]:undefined;
const valid=ref=>!!refProvider(ref);

/** Host-only OS encrypted credentials. Plugins and the renderer receive refs. */
export function createVoiceCredentials({dataRoot,crypto}){
  const path=join(dataRoot,'voice','credentials.json');
  let tail=Promise.resolve();
  function available(){if(crypto?.isEncryptionAvailable?.()!==true)throw fail('系统密钥加密不可用，未保存 API Key','VOICE_CREDENTIAL_ENCRYPTION');}
  async function read(){
    await assertPluginTreeNoLinks(path);
    try{const value=JSON.parse(await readFile(path,'utf8'));if(value.version!==1||!value.keys)throw fail('语音密钥存储格式无效','VOICE_CREDENTIAL_INVALID');return value;}
    catch(error){if(error.code==='ENOENT')return {version:1,keys:{}};throw error;}
  }
  return {
    save(key,{providerId='minimax'}={}){
      const operation=tail.then(async()=>{
        available();
        if(!providerIds.has(providerId)||typeof key!=='string'||key.length<8||key.length>8192||/[\r\n\0]/.test(key))throw fail('API Key 格式无效','VOICE_CREDENTIAL_INVALID');
        const state=await read(),ref='voice:'+providerId+':'+randomUUID();
        state.keys[ref]={provider:providerId,ciphertext:crypto.encryptString(key.trim()).toString('base64')};
        await mkdir(dirname(path),{recursive:true});await assertPluginTreeNoLinks(path);writeAtomic(path,JSON.stringify(state));
        return {ref,configured:true};
      });
      tail=operation.catch(()=>{});return operation;
    },
    async resolve(ref){
      if(!valid(ref))throw fail('无效的语音密钥引用','VOICE_CREDENTIAL_INVALID');
      await tail;available();const row=(await read()).keys[ref];
      if(row?.provider!==refProvider(ref)||typeof row.ciphertext!=='string')throw fail('请先保存 MiniMax API Key','VOICE_CREDENTIAL_MISSING');
      try{return crypto.decryptString(Buffer.from(row.ciphertext,'base64'));}
      catch{throw fail('此系统不能解密语音密钥，请重新填写','VOICE_CREDENTIAL_ENCRYPTION');}
    },
    removeIfUnused(ref,isReferenced){
      const operation=tail.then(async()=>{
        if(!valid(ref)||typeof isReferenced!=='function')throw fail('无效的语音密钥清理请求','VOICE_CREDENTIAL_INVALID');
        if(await isReferenced(ref))return {removed:false,referenced:true};
        const state=await read();if(!Object.hasOwn(state.keys,ref))return {removed:false};
        delete state.keys[ref];await assertPluginTreeNoLinks(path);
        try{writeAtomic(path,JSON.stringify(state));}catch{throw fail('配置已保存，但旧密钥清理尚未完成；原加密记录仍保留','VOICE_CREDENTIAL_CLEANUP_PENDING');}
        return {removed:true};
      });tail=operation.catch(()=>{});return operation;
    },
  };
}
