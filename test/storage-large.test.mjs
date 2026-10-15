import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
test('large snapshots retain version semantics, compact receipts and recover from corrupt last commit',async()=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-large-')),path=join(root,'index.json'),options={retainText:false,compactReceipt:true},s=createSnapshotStorage(path,options);
 const a=await s.writeText(JSON.stringify({a:'orange'.repeat(100000)}),{kind:'createIfAbsent'});
 assert.deepEqual(Object.keys(a).sort(),['operation','version']);assert.equal(a.operation,'create');
 await assert.rejects(s.writeText('{}',{kind:'replaceIfVersion',version:'wrong'}),{code:'FS_STALE_VERSION'});
 const content=await s.readText();assert.equal((await s.writeText(content)).operation,'unchanged');
 const b=await s.writeText('{"b":2}',{kind:'replaceIfVersion',version:a.version});
 writeFileSync(join(path+'.snapshots',b.version),'corrupt');
 const recovered=createSnapshotStorage(path,options);assert.equal((await recovered.stat()).version,a.version);assert.equal((await readJson(recovered,{})).a.length,600000);
 const one=recovered.writeText('{"n":1}'),two=recovered.writeText('{"n":2}');await Promise.all([one,two]);assert.deepEqual(await readJson(recovered,{}),{n:2});
 const small=createSnapshotStorage(join(root,'settings.json'));await small.writeText('old');assert.equal((await small.writeText('new')).before,'old');
});
