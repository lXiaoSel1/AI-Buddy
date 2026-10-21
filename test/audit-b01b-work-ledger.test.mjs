import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,existsSync,readFileSync,unlinkSync} from 'node:fs';
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
 await sleep(400);const before=snapshotCount(dataRoot),bank0=(await savedTokens(dataRoot)).bank;
 let sum=0;for(let n=0;n<8;n++){game.workTokens(1000+n);sum+=1000+n;await sleep(330);}
 await sleep(400);
 assert.equal(snapshotCount(dataRoot),before,'no global snapshot per work-token delta');
 await game.flushWorkLedger();
 const tokens=await savedTokens(dataRoot);
 assert.equal(tokens.bank,bank0+sum);assert.equal(tokens.workFolded,sum);
 game.close();await sleep(200);
 assert.equal(ledger(dataRoot).total,sum);
 const again=await createGalgame({dataRoot,provider,model:'fixture'});await sleep(300);await again.flushWorkLedger();
 assert.equal((await savedTokens(dataRoot)).bank,bank0+sum,'reopening does not count the ledger twice');
 again.close();
});

test('a crash after the counter is saved but before the global save loses nothing',async t=>{
 const dataRoot=fresh(t),crashed=await createGalgame({dataRoot,provider,model:'fixture'});
 await sleep(300);const bank0=(await savedTokens(dataRoot)).bank;
 crashed.workTokens(5000);await sleep(2300);
 assert.equal(ledger(dataRoot).total,5000);assert.equal((await savedTokens(dataRoot)).bank,bank0,'global not written yet');
 const next=await createGalgame({dataRoot,provider,model:'fixture'});await sleep(300);await next.flushWorkLedger();
 assert.deepEqual([(await savedTokens(dataRoot)).bank,(await savedTokens(dataRoot)).workFolded],[bank0+5000,5000]);
 next.close();crashed.close();await sleep(200);
 unlinkSync(join(home(dataRoot),'work-tokens.json'));
 const reset=await createGalgame({dataRoot,provider,model:'fixture'});await sleep(300);await reset.flushWorkLedger();
 assert.deepEqual([(await savedTokens(dataRoot)).bank,(await savedTokens(dataRoot)).workFolded],[bank0+5000,0],'a missing counter never removes banked tokens');
 reset.close();
});
