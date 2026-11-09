import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,existsSync,readFileSync,unlinkSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {createGalgame} from '../src/galgame-host.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';

const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}]};
const home=dataRoot=>join(dataRoot,'galgame','storages','dsh-whale-galgame');
const snapshotCount=dataRoot=>{const root=join(home(dataRoot),'global.json.snapshots');return existsSync(root)?readdirSync(root).filter(n=>n.endsWith('.json')&&!n.startsWith('retention-')).length:0;};
const savedTokens=async dataRoot=>JSON.parse(await createSnapshotStorage(join(home(dataRoot),'global.json')).readText()).tokens;
const ledger=dataRoot=>JSON.parse(readFileSync(join(home(dataRoot),'work-tokens.json'),'utf8'));
const fresh=t=>{const dir=mkdtempSync(join(tmpdir(),'audit-b01b-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

test('work-token deltas no longer write full global snapshots and fold into the bank exactly once',async t=>{
 const dataRoot=fresh(t),game=await createGalgame({dataRoot,provider,model:'fixture'});
 await sleep(400);await game.flushSaves();const before=snapshotCount(dataRoot),bank0=(await savedTokens(dataRoot)).bank;
 let sum=0;for(let n=0;n<8;n++){game.workTokens(1000+n);sum+=1000+n;await sleep(330);}
 await sleep(400);
 assert.equal(snapshotCount(dataRoot),before,'no global snapshot per work-token delta');
 await game.flushWorkLedger();await game.flushSaves();
 const tokens=await savedTokens(dataRoot);
 assert.equal(tokens.bank,bank0+sum);assert.equal(tokens.workFolded,sum);
 await game.close();await sleep(200);
 assert.equal(ledger(dataRoot).total,sum);
 const again=await createGalgame({dataRoot,provider,model:'fixture'});await sleep(300);await again.flushWorkLedger();await again.flushSaves();
 assert.equal((await savedTokens(dataRoot)).bank,bank0+sum,'reopening does not count the ledger twice');
 await again.close();
});

test('a crash after the counter is saved but before the global save loses nothing',async t=>{
 const dataRoot=fresh(t),crashed=await createGalgame({dataRoot,provider,model:'fixture'});
 await sleep(300);await crashed.flushSaves();const bank0=(await savedTokens(dataRoot)).bank;
 crashed.workTokens(5000);await sleep(2300);
 assert.equal(ledger(dataRoot).total,5000);assert.equal((await savedTokens(dataRoot)).bank,bank0,'global not written yet');
 // Reopen a crash-time disk image. Closing the old live instance must never
 // flush its newer memory into the image being used to simulate a crash.
 const mirror=fresh(t);cpSync(dataRoot,mirror,{recursive:true});
 const next=await createGalgame({dataRoot:mirror,provider,model:'fixture'});await sleep(300);await next.flushWorkLedger();await next.flushSaves();
 assert.deepEqual([(await savedTokens(mirror)).bank,(await savedTokens(mirror)).workFolded],[bank0+5000,5000]);
 await next.close();await crashed.close();await sleep(200);
 unlinkSync(join(home(mirror),'work-tokens.json'));
 const reset=await createGalgame({dataRoot:mirror,provider,model:'fixture'});await sleep(300);await reset.flushWorkLedger();await reset.flushSaves();
 assert.deepEqual([(await savedTokens(mirror)).bank,(await savedTokens(mirror)).workFolded],[bank0+5000,0],'a missing counter never removes banked tokens');
 await reset.close();
});
