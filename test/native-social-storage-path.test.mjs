import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,toNamespacedPath} from 'node:path';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';

const identity={pluginId:'source-bound-qq',sourceId:'source-one',packageName:'@ai-buddy/qq-connect',exactVersion:'1.0.2',sourceDigest:'1'.repeat(64)};
const origin={runtimeId:'runtime',profileId:'imported-profile',pid:process.pid};

async function fixture(t,{long=false}={}){
  const root=await mkdtemp(join(tmpdir(),'native-social-path-'));
  const dataRoot=join(root,long?'x'.repeat(Math.max(10,159-root.length-1)):'profile');
  const host=createNativeSocialFacade({dataRoot,contract:{hash:'storage-contract',methods:[]},handlers:{},authorizeUI:async()=>false,resolveGrant:async()=>null,contextProvider:async()=>null});
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  const open=(options={})=>host.open({identity,origin,contractHash:'storage-contract',...options});
  return {host,dataRoot,open};
}

test('native social storage opens the real SQLite registry at imported Windows profile path lengths', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t,{long:true}),opened=await f.open();
  const registry=join(opened.dataDirectory,'account-directories-v1.sqlite');
  assert.ok(registry.length>260,'fixture must exercise the Windows SQLite path boundary');
  const db=new DatabaseSync(registry);
  try {db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO metadata VALUES(?,?)').run('fixture','preserved');}
  finally {db.close();}
  const reopened=await f.open(),read=new DatabaseSync(join(reopened.dataDirectory,'account-directories-v1.sqlite'),{readOnly:true});
  try {assert.equal(read.prepare('SELECT value FROM metadata WHERE key=?').get('fixture').value,'preserved');}
  finally {read.close();}
});

test('native social storage keeps the same short physical profile and source identity boundaries',async t=>{
  const f=await fixture(t),opened=await f.open();
  const suffix=relative(toNamespacedPath(f.dataRoot),toNamespacedPath(opened.dataDirectory));
  assert.match(suffix,/^plugin-data[\\/]social-v1[\\/][a-f0-9]{64}$/);
  const registry=join(opened.dataDirectory,'account-directories-v1.sqlite'),ordinary=join(f.dataRoot,suffix,'account-directories-v1.sqlite');
  const db=new DatabaseSync(registry);
  try {db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO metadata VALUES(?,?)').run('fixture','original-profile');}
  finally {db.close();}
  const read=new DatabaseSync(ordinary,{readOnly:true});
  try {assert.equal(read.prepare('SELECT value FROM metadata WHERE key=?').get('fixture').value,'original-profile');}
  finally {read.close();}
  const [native,plain]=await Promise.all([stat(registry),stat(ordinary)]);
  assert.equal(native.dev,plain.dev);assert.equal(native.ino,plain.ino);
  assert.equal((await f.open()).dataDirectory,opened.dataDirectory);
  assert.notEqual((await f.open({identity:{...identity,sourceId:'source-two'}})).dataDirectory,opened.dataDirectory);
  assert.notEqual((await f.open({identity:{...identity,pluginId:'Source-bound-qq'}})).dataDirectory,opened.dataDirectory);
  await assert.rejects(f.host.dispatch({sessionToken:opened.sessionToken,method:'close'},{...origin,pid:origin.pid+1}),{code:'SOCIAL_RUNTIME_SCOPE_DENIED'});
  await assert.rejects(f.open({identity:{...identity,sourceDigest:'invalid'}}),{code:'SOCIAL_PACKAGE_IDENTITY_REQUIRED'});
});
