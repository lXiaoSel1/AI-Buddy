import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createSocialAccounts} from '../src/buddy-plugin-services/social-accounts.mjs';

async function fixture(t){
  const tempRoot=resolve(tmpdir());
  const dataRoot=await mkdtemp(join(tempRoot,'social-account-storage-'));
  t.after(async()=>{
    assert.ok(resolve(dataRoot).startsWith(tempRoot+sep));
    await rm(dataRoot,{recursive:true,force:true});
  });
  const directory=join(dataRoot,'social-core');
  await mkdir(directory);
  return {dataRoot,path:join(directory,'accounts-v1.sqlite')};
}

function startupFailure(dataRoot,stage){
  let failure;
  assert.throws(()=>createSocialAccounts({dataRoot}).close(),error=>{
    failure=error;
    assert.equal(error.code,'SOCIAL_STORAGE_UNAVAILABLE');
    assert.equal(error.database,'social-core/accounts-v1.sqlite');
    assert.equal(error.stage,stage);
    return true;
  });
  return failure.cause;
}

test('an unreadable social accounts database reports the SQLite read failure without changing its bytes',async t=>{
  const {dataRoot,path}=await fixture(t);
  const bytes=Buffer.from('this file is not a SQLite database');
  await writeFile(path,bytes);
  assert.equal(startupFailure(dataRoot,'user-version')?.errcode,26);
  assert.deepEqual(await readFile(path),bytes);
});

for(const suffix of ['-wal','-shm']){
  test(`the social accounts database is not recreated when only its ${suffix.slice(1)} remains`,async t=>{
    const {dataRoot,path}=await fixture(t);
    const sidecar=path+suffix;
    const bytes=Buffer.from('original account recovery data');
    await writeFile(sidecar,bytes);
    assert.equal(startupFailure(dataRoot,'inspect')?.code,'SOCIAL_ACCOUNT_MAIN_FILE_MISSING');
    await assert.rejects(readFile(path),{code:'ENOENT'});
    assert.deepEqual(await readFile(sidecar),bytes);
  });
}

test('an unsupported legacy schema leaves the original database untouched',async t=>{
  const {dataRoot,path}=await fixture(t);
  const db=new DatabaseSync(path);
  try{
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schemaVersion','2');");
  }finally{db.close();}
  const before=await readFile(path);
  assert.equal(startupFailure(dataRoot,'schema-check')?.code,'SOCIAL_ACCOUNT_SCHEMA_UNSUPPORTED');
  assert.deepEqual(await readFile(path),before);
});

for(const markerTable of ['metadata','meta']){
  test(`a versioned social database with a missing accounts table is preserved (${markerTable})`,async t=>{
    const {dataRoot,path}=await fixture(t);
    const db=new DatabaseSync(path);
    try{
      db.exec(`CREATE TABLE ${markerTable}(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO ${markerTable} VALUES('schemaVersion','1');`);
    }finally{db.close();}
    const before=await readFile(path);
    assert.equal(startupFailure(dataRoot,'schema-check')?.code,'SOCIAL_ACCOUNT_SCHEMA_INVALID');
    assert.deepEqual(await readFile(path),before);
  });
}

test('an incompatible accounts table is rejected before opening a writer',async t=>{
  const {dataRoot,path}=await fixture(t);
  const db=new DatabaseSync(path);
  try{db.exec('CREATE TABLE accounts(ref TEXT PRIMARY KEY,body TEXT NOT NULL);');}
  finally{db.close();}
  const before=await readFile(path);
  assert.equal(startupFailure(dataRoot,'schema-check')?.code,'SOCIAL_ACCOUNT_SCHEMA_INVALID');
  assert.deepEqual(await readFile(path),before);
});

for(const [description,body] of [
  ['malformed JSON','{"account":"private-fixture-value"'],
  ['a JSON array','["private-fixture-value"]'],
]){
  test(`a saved body containing ${description} is rejected without exposing the body`,async t=>{
    const {dataRoot,path}=await fixture(t);
    const db=new DatabaseSync(path);
    try{
      db.exec('CREATE TABLE accounts(ref TEXT PRIMARY KEY,body TEXT NOT NULL,secret BLOB);');
      db.prepare('INSERT INTO accounts VALUES(?,?,?)').run('fixture',body,null);
    }finally{db.close();}
    const before=await readFile(path);
    const cause=startupFailure(dataRoot,'schema-check');
    assert.equal(cause?.code,'SOCIAL_ACCOUNT_BODY_INVALID');
    assert.doesNotMatch(cause?.message,/private-fixture-value/);
    assert.deepEqual(await readFile(path),before);
  });
}

test('a failed initialization rolls back schema writes and releases the writer',async t=>{
  const {dataRoot,path}=await fixture(t);
  const db=new DatabaseSync(path);
  try{
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TRIGGER fail_account_setup BEFORE INSERT ON meta
      WHEN NEW.key='minimumWriter' BEGIN SELECT RAISE(ABORT,'fixture initialization failure'); END;
    `);
  }finally{db.close();}
  const before=await readFile(path);
  assert.equal(startupFailure(dataRoot,'initialize')?.message,'fixture initialization failure');
  assert.deepEqual(await readFile(path),before);
  const recovery=new DatabaseSync(path);
  try{
    recovery.exec('BEGIN IMMEDIATE;');
    assert.equal(recovery.prepare('SELECT COUNT(*) n FROM meta').get().n,0);
    recovery.exec('DROP TRIGGER fail_account_setup; COMMIT;');
  }finally{recovery.close();}
  const accounts=createSocialAccounts({dataRoot});
  try{assert.deepEqual(accounts.list(),[]);}finally{accounts.close();}
});

test('a new profile can create a social accounts database and reopen the original account',async t=>{
  const {dataRoot}=await fixture(t);
  const freshRoot=join(dataRoot,'new-profile');
  const accounts=createSocialAccounts({dataRoot:freshRoot});
  let saved;
  try{
    saved=accounts.save({pluginId:'@ai-buddy/bilibili-companion',accountId:'123',label:'Account fixture'});
  }finally{accounts.close();}
  const reopened=createSocialAccounts({dataRoot:freshRoot});
  try{assert.deepEqual(reopened.list(),[saved]);}finally{reopened.close();}
});

test('an unversioned legacy account can still be opened',async t=>{
  const {dataRoot,path}=await fixture(t);
  const original={ref:'legacy-account',pluginId:'@ai-buddy/bilibili-companion',platform:'bilibili',accountId:'123',label:'Legacy account',generation:1,enabled:true};
  const db=new DatabaseSync(path);
  try{
    db.exec('CREATE TABLE accounts(ref TEXT PRIMARY KEY,body TEXT NOT NULL,secret BLOB);');
    db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(original.ref,JSON.stringify(original),null);
  }finally{db.close();}
  const accounts=createSocialAccounts({dataRoot});
  try{assert.deepEqual(accounts.list(),[original]);}finally{accounts.close();}
});
