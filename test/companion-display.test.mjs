import test from 'node:test';
import assert from 'node:assert/strict';
import {affectionText,dialogueLineRoom} from '../src/companion-display.mjs';
test('affection display floors earned integers without changing progression precision',()=>{for(const [value,wanted]of [[150.20000000000005,'150'],[447.20000000000005,'447'],[0.1+0.2,'0'],[652.2,'652'],[99.999999,'99'],[12,'12'],[12.25,'12'],[0,'0'],[-1,'0'],[NaN,'0'],[Infinity,'0']]){const state={affection:value};assert.equal(affectionText(state.affection),wanted);assert.equal(Object.is(state.affection,value),true);}});
test('dialogue gets whole text lines and more room as the reply area shrinks',()=>{const large=dialogueLineRoom(900,260,31),compact=dialogueLineRoom(900,180,31);assert.ok(compact>large);assert.equal(compact%31,0);assert.equal(dialogueLineRoom(400,200,31),62);assert.equal(dialogueLineRoom(900,180,NaN),155);});
