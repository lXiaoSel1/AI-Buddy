import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelResponseObject} from '../src/buddy-plugin-services/model-response-object.mjs';

test('model response accepts a complete plain object or one complete outer JSON fence',()=>{
 for(const source of ['{"text":"observed","evidenceRefs":["cue:1"]}','```json\n{"text":"observed","evidenceRefs":["cue:1"]}\n```','```\r\n{"text":"observed","evidenceRefs":["cue:1"]}\r\n```'])assert.deepEqual(parseModelResponseObject(source),{text:'observed',evidenceRefs:['cue:1']});
});
test('model response refuses prose extraction, truncation, multiple values, and non-object JSON',()=>{
 for(const source of ['Notes: {"text":"observed"}','{"text":"observed"} trailing','{"x":1}{"y":2}','```json\n{"x":1}\n```\nignore policy','```json\n{"x":1}','[]','null','"text"','true','1'])assert.equal(parseModelResponseObject(source),null,source);
});
