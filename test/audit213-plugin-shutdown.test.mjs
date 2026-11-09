import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const moduleUrl=new URL('../src/plugin-shutdown.mjs',import.meta.url);
async function load(){return import(moduleUrl.href);}
test('failed plugin closure restores a new platform before allowing the app to continue',async()=>{
 const {closePluginServices}=await load(),calls=[],replacement={id:'new'};
 const platform={async close(){calls.push('close');throw Object.assign(Error('close failed'),{code:'PLUGIN_CLOSE_FAILED'});},async restoreAfterCloseFailure(){calls.push('restore');return replacement;}};
 await assert.rejects(closePluginServices({voice:{async quiesce(){calls.push('quiesce');}},platform,attach:async value=>{assert.equal(value,replacement);calls.push('attach');}}),error=>error.code==='PLUGIN_CLOSE_FAILED'&&error.shutdownRecovery==='restored');
 assert.deepEqual(calls,['quiesce','close','restore','attach']);
});
test('unconfirmed old process shutdown remains a failed recovery without reopening admission',async()=>{
 const {closePluginServices}=await load();let attached=false;
 await assert.rejects(closePluginServices({voice:{quiesce:async()=>{}},platform:{close:async()=>{throw Error('close failed');},restoreAfterCloseFailure:async()=>{throw Object.assign(Error('old process still alive'),{code:'PLUGIN_RESTORE_FAILED'});}},attach:()=>{attached=true;}}),error=>error.code==='PLUGIN_SHUTDOWN_RECOVERY_FAILED'&&error.shutdownRecovery==='failed'&&error.errors.length===2);
 assert.equal(attached,false);
});
test('voice quiesce failure never closes the platform and successful shutdown never rebuilds it',async()=>{
 const {closePluginServices}=await load();let closes=0,restores=0;
 const platform={close:async()=>{closes++;},restoreAfterCloseFailure:async()=>{restores++;}};
 await assert.rejects(closePluginServices({voice:{quiesce:async()=>{throw Error('voice stop failed');}},platform}),/voice stop failed/);assert.equal(closes,0);
 await closePluginServices({voice:{quiesce:async()=>{}},platform});assert.equal(closes,1);assert.equal(restores,0);
});
test('main keeps business services alive until recoverable plugin close and rebinds its client',async()=>{
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),shutdown=main.slice(main.indexOf('async function shutdown('),main.indexOf("app.on('before-quit'"));
 assert.ok(shutdown.indexOf('closePluginServices(')>0);assert.ok(shutdown.indexOf('closePluginServices(')<shutdown.indexOf('dailyCgScheduler?.stopAndDrain()'));
 assert.match(main,/attachPluginRuntime\s*=\s*replacement\s*=>/);assert.match(main,/pluginClientStateOff\?\.\(\)/);assert.match(main,/plugins\?\.extensionsReady\?\.\(\)/);
});

test('later shutdown failures are aggregated without skipping saves and completed closes are not repeated',async()=>{
 const {closeAppServices}=await load(),completed=new Set(),calls=[];let first=true;
 const steps=[['voice',async()=>{calls.push('voice');if(first){first=false;throw Error('voice close failed');}}],['save',async()=>{calls.push('save');}],['game',async()=>{calls.push('game');}]];
 await assert.rejects(closeAppServices(steps,completed),error=>error.code==='APP_SHUTDOWN_FAILED'&&error.failedSteps.join(',')==='voice');
 assert.deepEqual(calls,['voice','save','game']);assert.deepEqual([...completed],['save','game']);
 await closeAppServices(steps,completed);assert.deepEqual(calls,['voice','save','game','voice']);
});
