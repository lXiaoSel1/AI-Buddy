import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function hook(source){const code=source.split('\n').find(line=>line.startsWith("app.on('before-quit',"));assert(code,'Actual main quit hook missing');let handler,calls=0;const context=vm.createContext({quitting:false,app:{on(name,fn){assert.equal(name,'before-quit');handler=fn;}},shutdown(){calls++;context.quitting=true;}});vm.runInContext(code,context);return {fire(){let prevented=false;handler({preventDefault(){prevented=true;}});return prevented;},get calls(){return calls;},context};}
const source=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8');
test('actual main hook prevents repeated app quits while durable close remains pending',()=>{const value=hook(source);assert.equal(value.fire(),true);assert.equal(value.calls,1);assert.equal(value.fire(),true);assert.equal(value.calls,1);assert.equal(value.fire(),true);assert.equal(value.calls,1);});
test('actual main hook allows another shutdown attempt after a failed close without allowing default exit',()=>{const value=hook(source);value.fire();value.context.quitting=false;assert.equal(value.fire(),true);assert.equal(value.calls,2);assert.equal(value.fire(),true);assert.equal(value.calls,2);});
test('original conditional preventDefault fails the repeated-quit regression',()=>{const original="app.on('before-quit',event=>{if(!quitting){event.preventDefault();void shutdown();}});",value=hook(original);assert.equal(value.fire(),true);assert.equal(value.fire(),false);assert.equal(value.calls,1);});
