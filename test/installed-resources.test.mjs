import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createInstalledResources} from '../src/installed-resources.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
const json=(p,v)=>writeFileSync(p,JSON.stringify(v));
test('Resource availability uses physical files, supports legacy full trees and never treats unknown as installed',()=>{
 const root=mkdtempSync(join(tmpdir(),'ai-buddy-resources-')),build=join(root,'builds/test');mkdirSync(join(build,'assets'),{recursive:true});
 const index={version:1,appVersion:'1.8.0',edition:'30fps',shared:[],characters:{claude:[{path:'assets/claude.webp',bytes:3}],deepseek:[{path:'assets/deepseek.webp',bytes:3}]}};
 json(join(build,'assets/install-resource-index.json'),index);writeFileSync(join(build,'assets/claude.webp'),'abc');
 const registry=createInstalledResources({root,build});assert.equal(registry.available('claude'),true);assert.equal(registry.available('deepseek'),false);assert.equal(registry.fallback('deepseek'),'claude');assert.equal(registry.available('unlisted'),false);assert.equal(registry.status().legacy,true);
 assert.throws(()=>registry.require(['claude','deepseek']),e=>e.code==='CHARACTER_NOT_INSTALLED'&&e.characterIds[0]==='deepseek');
 unlinkSync(join(build,'assets/claude.webp'));registry.status(true);assert.equal(registry.available('claude'),false);assert.equal(registry.fallback(),null);
});
test('Single-role Galgame initializes available identity; selecting missing role is atomic; following unavailable model keeps current',async()=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'ai-buddy-selected-role-'));let calls=0;
 const provider={enabled:false,currentSelection:()=>({provider:'openai',model:'gpt-6.1-sol'}),listProviders:()=>[{id:'openai'}],async *stream(){calls++;throw Error('No model calls allowed');}};
 const resources={available:id=>id==='claude',fallback:()=> 'claude',status:()=>({initialCharacter:'claude',characters:[{id:'claude',installed:true},{id:'chatgpt',installed:false}]})};
 const game=await createGalgame({dataRoot,provider,model:'fixture',resources});
 try{assert.equal((await game.action('view')).current,'claude');const settings=await game.action('settings-get');const rejected=await game.action('settings-set',{characterMode:'manual',characterId:'qwen',petEnabled:false});assert.equal(rejected.code,'CHARACTER_NOT_INSTALLED');assert.equal((await game.action('settings-get')).petEnabled,settings.petEnabled);assert.equal((await game.action('view')).current,'claude');await game.action('settings-set',{characterMode:'follow',characterId:null});const followed=await game.action('view');assert.equal(followed.current,'claude');assert.equal(followed.resourcePendingCharacter,'chatgpt');assert.equal(calls,0);}finally{game.close();}
});
