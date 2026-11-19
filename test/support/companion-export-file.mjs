import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function readCompanionExport(app,action,args){
  const result=await app.action(action,args);
  assert.equal(result.data,undefined);
  assert.ok(result.export?.path,'a portable export returns a file path');
  return JSON.parse(await readFile(result.export.path,'utf8'));
}