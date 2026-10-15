import test from 'node:test';import assert from 'node:assert/strict';import {resolve,dirname} from 'node:path';
import {relocateSequenceCollection} from '../scripts/relocate-sequence-collection.mjs';
test('activating a nested multi-character collection preserves every source path',()=>{
 const source=resolve('local/buddy-178/collection.json'),absolute=resolve('local/retained/manifest.json');
 const original={backend:'webm-alpha',characters:{claude:{manifests:['animations/claude/idle/manifest.json',absolute]},chatgpt:{manifests:['animations-r8/gpt/idle/manifest.json']}}};
 const relocated=relocateSequenceCollection(original,source);
 assert.equal(relocated.characters.claude.manifests[0],resolve(dirname(source),original.characters.claude.manifests[0]));assert.equal(relocated.characters.claude.manifests[1],absolute);assert.equal(relocated.characters.chatgpt.manifests[0],resolve(dirname(source),original.characters.chatgpt.manifests[0]));assert.equal(original.characters.claude.manifests[0],'animations/claude/idle/manifest.json');
});
test('legacy collections retain aliases while their relative manifests are rebased',()=>{
 const source=resolve('local/old/collection.json'),original={manifests:['idle/manifest.json'],aliases:[{actionId:'wave',resourceId:'idle'}]};const next=relocateSequenceCollection(original,source);
 assert.equal(next.manifests[0],resolve(dirname(source),'idle/manifest.json'));assert.deepEqual(next.aliases,original.aliases);
});
