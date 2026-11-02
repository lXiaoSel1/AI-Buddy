import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeDashboardPage} from '../src/dashboard-pages.mjs';

test('native/CLI social menu aliases and legacy sessions resolve to the exact sidebar page identity',()=>{
 for(const [input,expected]of [['shop','r95-shop'],['backpack','r95-inventory'],['social','r95-social'],['sessions','overview'],['','overview'],[null,'overview'],[undefined,'overview']])assert.equal(normalizeDashboardPage(input),expected);
 for(const input of ['overview','settings','galgame','agent-tasks','plugins','actions','r95-shop','r95-inventory','r95-social','data-import','__proto__','constructor'])assert.equal(normalizeDashboardPage(input),input);
});

test('initial hash, native panel:page and actual hashchange subscribe to the same normalization without leaking a listener',async()=>{
 const source=await readFile(new URL('../src/dashboard.mjs',import.meta.url),'utf8');assert.match(source,/useState\(normalizeDashboardPage\(location.hash.slice\(1\)\)\)/);assert.match(source,/onPage\(p=>setPage\(normalizeDashboardPage\(p\)\)\)/);assert.match(source,/const hashChanged=\(\)=>setPage\(normalizeDashboardPage\(location.hash.slice\(1\)\)\)/);assert.match(source,/addEventListener\('hashchange',hashChanged\)/);assert.match(source,/removeEventListener\('hashchange',hashChanged\)/);
 const native=await readFile(new URL('../src/pet-menu.mjs',import.meta.url),'utf8');assert.match(native,/open\('shop'\)/);assert.match(native,/open\('backpack'\)/);assert.equal(normalizeDashboardPage('shop'),'r95-shop');assert.equal(normalizeDashboardPage('backpack'),'r95-inventory');
});
