import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {createPetButtonObserver} from '../src/pet-buttons.mjs';
test('Native button observer ignores stale gestures, splits lines, stops on release and closes its pipe',()=>{
 const child=new EventEmitter(),sent=[],states=[];child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=s=>sent.push(s);child.stdin.end=()=>sent.push('EOF');
 const o=createPetButtonObserver({path:'fixture.exe',enabled:true,spawnImpl:()=>child,onState:s=>states.push(s)});o.start('new');child.stdout.emit('data','old|0\nnew|');child.stdout.emit('data','3\nnew|1\nnew|0\n');assert.deepEqual(states.map(s=>s.buttons),[3,1,0]);o.stop();child.stdout.emit('data','new|4\n');assert.equal(states.length,3);o.start('next');child.stdout.emit('data','next|4\n');assert.equal(states.at(-1).escape,true);o.close();assert.deepEqual(sent,['new\n','\n','next\n','EOF']);
});
test('Unavailable native observer reports failure without creating synthetic input',()=>{
 const child=new EventEmitter(),errors=[];child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=()=>{};child.stdin.end=()=>{};const o=createPetButtonObserver({path:'missing.exe',enabled:true,spawnImpl:()=>child,onState:()=>assert.fail('no synthetic events'),onError:e=>errors.push(e.message)});child.emit('error',Error('missing'));assert.deepEqual(errors,['missing']);o.close();
});
