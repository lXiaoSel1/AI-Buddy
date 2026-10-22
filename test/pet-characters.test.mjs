import test from 'node:test';
import assert from 'node:assert/strict';
import {PET_CHARACTERS,resolvePetCharacter,normalizePetCharacter,brandPetCharacter} from '../src/pet-characters.mjs';
import {PetCharacterSwitch} from '../src/pet-character-switch.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('Follow uses the selected character independently of the API; fixed mode stays fixed',()=>{
 assert.equal(PET_CHARACTERS.length,11);
 assert.equal(resolvePetCharacter({petCharacterMode:'follow',petFixedCharacter:'claude'},'qwen'),'qwen');
 assert.equal(resolvePetCharacter({petCharacterMode:'fixed',petFixedCharacter:'claude'},'qwen'),'claude');
 assert.equal(resolvePetCharacter({},'gpt'),'chatgpt');
 assert.equal(normalizePetCharacter('missing'),'deepseek');
});

test('A prepared character switches without waiting for idle/work cycle boundaries, but protects active interactions',async()=>{
 const commits=[];const s=new PetCharacterSwitch({prepare:async id=>({id}),commit:(...args)=>commits.push(args)});
 s.request('claude');await settle();
 assert.equal(s.advance({busy:true}),false);assert.equal(s.current,'deepseek');
 assert.equal(s.advance({boundary:false}),true);assert.equal(s.current,'claude');assert.equal(commits.length,1);assert.equal(s.advance(),false);
});

test('Initial hidden-window preparation can commit before the startup greeting',async()=>{
 let prepared=0;const commits=[];const s=new PetCharacterSwitch({prepare:async id=>({id}),commit:id=>commits.push(id),onPrepared:()=>{prepared++;s.advance();}});
 s.request('claude');assert.equal(prepared,0);await settle();assert.equal(prepared,1);assert.equal(s.current,'claude');assert.deepEqual(commits,['claude']);
});

test('Rapid switching commits only the latest choice and releases obsolete resources',async()=>{
 const waiting=new Map(),disposed=[],commits=[];
 const s=new PetCharacterSwitch({prepare:id=>new Promise(resolve=>waiting.set(id,resolve)),commit:id=>commits.push(id)});
 s.request('claude');await settle();s.request('qwen');await settle();
 waiting.get('qwen')({dispose:()=>disposed.push('qwen')});await settle();s.advance();
 waiting.get('claude')({dispose:()=>disposed.push('claude')});await settle();
 assert.deepEqual(commits,['qwen']);assert.deepEqual(disposed,['claude']);assert.equal(s.current,'qwen');
});

test('Returning to the original character cancels a pending load; failures keep the current pet',async()=>{
 let finish;const disposed=[],errors=[];
 const s=new PetCharacterSwitch({prepare:()=>new Promise(resolve=>finish=resolve),commit:()=>assert.fail('No switch expected'),onError:e=>errors.push(e.message)});
 s.request('claude');await settle();s.request('deepseek');finish({dispose:()=>disposed.push(true)});await settle();assert.equal(s.loading,false);assert.deepEqual(disposed,[true]);
 s.prepare=async()=>{throw Error('Missing resource')};s.request('qwen');await settle();assert.equal(s.current,'deepseek');assert.equal(s.target,'deepseek');assert.equal(s.failed,true);assert.deepEqual(errors,['Missing resource']);
});

test('UI-190-01: brand icons show the pet on screen, not the settings target, and fall back while she is hidden',()=>{
 // a demo: settings say DeepSeek, the visible pet draws Grok
 assert.equal(brandPetCharacter({shown:true,reported:'grok',target:'deepseek'}),'grok');
 // a switch waiting for a reaction to finish: settings already say Claude, she still draws DeepSeek
 assert.equal(brandPetCharacter({shown:true,reported:'deepseek',target:'claude'}),'deepseek');
 // hidden, or nothing drawn yet: the settings target
 assert.equal(brandPetCharacter({shown:false,reported:'grok',target:'claude'}),'claude');
 assert.equal(brandPetCharacter({shown:true,reported:undefined,target:'qwen'}),'qwen');
 assert.equal(brandPetCharacter({shown:true,reported:'missing',target:'gpt'}),'chatgpt');
});
