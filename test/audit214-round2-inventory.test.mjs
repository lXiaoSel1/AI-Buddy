import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {loadPublicAssetInventory,PUBLIC_ASSET_INVENTORY_SHA256} from '../scripts/public-distribution-assets.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
test('current public inventory passes both production loaders with the same actual byte digest',()=>{
 const actual=createHash('sha256').update(readFileSync(join(repo,'scripts/media-baselines/public-204-assets.json'))).digest('hex');
 const inventory=loadPublicAssetInventory(repo);
 assert.equal(inventory.applicationVersion,'2.0.14');
 assert.equal(PUBLIC_ASSET_INVENTORY_SHA256,actual);
 const code='import sys;sys.path.insert(0,sys.argv[1]);from public_distribution_validation import load_inventory,INVENTORY_SHA256;load_inventory();print(INVENTORY_SHA256)';
 const result=spawnSync(process.platform==='win32'?'py':'python3',[...(process.platform==='win32'?['-3','-B']:['-B']),'-c',code,join(repo,'scripts')],{cwd:repo,encoding:'utf8',windowsHide:true});
 if(result.error)throw result.error;
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.trim(),actual);
});
