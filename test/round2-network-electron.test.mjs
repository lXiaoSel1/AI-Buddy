// Heavy runtime: run only through the task's single Electron coordinator.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const host=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('G2 real Electron resolves mixed PAC through HTTP CONNECT and falls back to DIRECT after rejection', {timeout:40000},async()=>{
  const output=process.env.ROUND2_NETWORK_OUTPUT??join(tmpdir(),'round2-network-electron');await mkdir(output,{recursive:true});const run=await mkdtemp(join(output,'electron-'));
  const key=join(run,'fixture-key.pem'),cert=join(run,'fixture-cert.pem'),openssl=process.env.AUDIT214_OPENSSL??'C:/Program Files/Git/usr/bin/openssl.exe';
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=AI Buddy Round2 local fixture','-addext','basicConstraints=critical,CA:TRUE','-addext','subjectAltName=IP:127.0.0.1,IP:127.0.0.2'],{stdio:'ignore',windowsHide:true});
  const env={...process.env,NODE_EXTRA_CA_CERTS:cert,ROUND2_NETWORK_RUN:run};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(join(host,'node_modules/electron/dist/electron.exe'),[join(host,'test/support/round2-network-electron.cjs'),'--user-data-dir='+join(run,'profile')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const chunks=[];child.stdout.on('data',value=>chunks.push(value));child.stderr.on('data',value=>chunks.push(value));const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});
  await writeFile(join(run,'electron.log'),Buffer.concat(chunks));const result=JSON.parse(await readFile(join(run,'result.json'),'utf8'));await writeFile(join(output,'electron-latest.json'),JSON.stringify({run,code,...result},null,2)+'\n');
  assert.ok(result.electron,'must use an actual Electron process');assert.equal(result.fatal,undefined,result.fatal);assert.equal(result.checks.length,3);for(const row of result.checks)assert.equal(row.ok,true,row.error);assert.equal(code,0);
});
