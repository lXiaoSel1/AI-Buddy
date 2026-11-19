import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as cache from '../src/companion-cache-store.mjs';

test('native thread metadata and cleanup intent survive worker restart without changing chat windows',async t=>{
 const root=mkdtempSync(join(tmpdir(),'companion-native-r3-')),stores=[];
 t.after(async()=>{for(const store of stores)await store.close();rmSync(root,{recursive:true,force:true});});
 assert.equal(typeof cache.createCompanionNativeStore,'function');
 const first=cache.createCompanionNativeStore(root);stores.push(first);
 const record={threadId:'synthetic-thread',scope:{conversationId:'conversation'},lastMessageId:'reply',instructionsHash:'a'.repeat(64),requestFieldsHash:'b'.repeat(64),cleanup:'archive'};
 assert.equal(await first.write('thread:synthetic-thread',record),true);
 await first.close();
 const second=cache.createCompanionNativeStore(root);stores.push(second);
 assert.deepEqual(await second.read('thread:synthetic-thread'),record);
 assert.deepEqual(await second.list(),[{key:'thread:synthetic-thread',value:record}]);
 const returned=await second.read('thread:synthetic-thread');returned.cleanup='delete';
 assert.equal((await second.read('thread:synthetic-thread')).cleanup,'archive');
 assert.equal(await second.remove('thread:synthetic-thread'),true);
 assert.equal(await second.read('thread:synthetic-thread'),null);
 const windows=cache.createCompanionCacheStore(root);stores.push(windows);await windows.ready();
 assert.equal(windows.read('thread:synthetic-thread'),null);
});
