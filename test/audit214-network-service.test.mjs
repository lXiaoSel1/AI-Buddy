import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const host=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=process.env.AUDIT214_SERVICE_OUTPUT??join(tmpdir(),'ai-buddy-audit214-service');
const hosts=['github.com','api.github.com','release-assets.githubusercontent.com','raw.githubusercontent.com','huggingface.co','model.audit214.invalid','api.deepseek.com','api.minimax.cn','api.bilibili.com','fixture.hdslb.com'];

test('real Electron Session and production network consumers preserve the network contract',async t=>{
  await mkdir(output,{recursive:true});
  const run=await mkdtemp(join(output,'run-'));
  const key=join(run,'fixture-key.pem'),cert=join(run,'fixture-cert.pem');
  const openssl=process.env.AUDIT214_OPENSSL??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=AI Buddy audit214 test only','-addext','basicConstraints=critical,CA:TRUE','-addext','subjectAltName='+hosts.map(host=>'DNS:'+host).join(',')],{stdio:'ignore',windowsHide:true});
  const report=join(run,'result.json'),env={...process.env,NODE_EXTRA_CA_CERTS:cert,AUDIT214_SERVICE_RUN:run};
  delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(join(host,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron'),[join(host,'test/support/audit214-network-electron.cjs'),'--user-data-dir='+join(run,'profile')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const chunks=[];child.stdout.on('data',value=>chunks.push(value));child.stderr.on('data',value=>chunks.push(value));
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);});
  await writeFile(join(run,'electron.log'),Buffer.concat(chunks));
  const result=JSON.parse(await readFile(report,'utf8'));
  await writeFile(join(output,'latest.json'),JSON.stringify({run,code,...result},null,2)+'\n');
  assert.equal(result.electron,'44.6.0');
  assert.equal(result.fatal,undefined,result.fatal);
  for(const row of result.checks)await t.test(row.name,{skip:row.skipped?row.skipReason:false},()=>assert.equal(row.ok,true,row.error));
  assert.equal(code,0,'Electron helper should exit normally after collecting all checks');
});
