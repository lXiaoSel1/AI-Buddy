import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {THEME_PALETTES} from '../src/theme-palettes.mjs';

const file=(id,name)=>new URL(`../assets/theme/${id}/${name}`,import.meta.url);

test('every theme ships its backdrop, ornament, head, portrait and round icons',()=>{
 for(const {id} of THEME_PALETTES){
  for(const name of ['bg.webp','orn.webp','head.webp','portrait.webp']){
   const bytes=readFileSync(file(id,name));
   assert.equal(bytes.toString('latin1',0,4)+bytes.toString('latin1',8,12),'RIFFWEBP',id+' '+name);
  }
  for(const [name,size] of [['icon-256.png',256],['tray-16.png',16],['tray-24.png',24],['tray-32.png',32]]){
   const bytes=readFileSync(file(id,name));
   assert.equal(bytes.toString('latin1',1,4),'PNG',id+' '+name);
   assert.equal(bytes.toString('latin1',12,16),'IHDR');
   assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[size,size],id+' '+name);
   assert.equal(bytes[25],6,id+' '+name+' needs an alpha channel for the round cut');
  }
 }
});

test('theme assets stay small and the public build copies them',()=>{
 let total=0;for(const {id} of THEME_PALETTES)for(const name of ['bg.webp','orn.webp','head.webp','portrait.webp','icon-256.png','tray-16.png','tray-24.png','tray-32.png'])total+=statSync(file(id,name)).size;
 assert.ok(total<4*1024*1024,`theme assets total ${total} bytes`);
 const build=readFileSync(new URL('../scripts/build-public.mjs',import.meta.url),'utf8');
 assert.match(build,/assets','theme'|assets\/theme/);
 const css=readFileSync(new URL('../src/appearance.css',import.meta.url),'utf8');
 for(const {id} of THEME_PALETTES)assert.ok(css.includes(`theme/${id}/bg.webp`),id);
});
