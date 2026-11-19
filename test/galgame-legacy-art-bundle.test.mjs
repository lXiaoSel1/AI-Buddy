import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {WHALE_ART} from '../src/adapted/art.generated.ts';

test('the Galgame renderer strips the retired DeepSeek expressions and retains working legacy assets',async()=>{
 const {outputFiles}=await build({
  entryPoints:['src/adapted/galgame-client.ts'],bundle:true,write:false,platform:'browser',
  target:'chrome144',format:'esm',logLevel:'silent',
 });
 const renderer=outputFiles[0].text;
 const retired=renderer.match(/\bwhale-(?:cheerful|shy|serious|confused|angry|frightened|exasperated|starry)\b/g)??[];
 assert.deepEqual([...new Set(retired)],[],'retired expression payloads are absent from the renderer');
 for(const key of ['pet-spritesheet','palace-night','bg-kimi-moonlit-reading-study']){
  assert.ok(WHALE_ART[key]?.startsWith('data:image/'));
  assert.ok(renderer.includes(WHALE_ART[key]),key+' remains available in the renderer');
 }
});
