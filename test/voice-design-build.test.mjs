import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,copyFileSync,existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
test('the real public staging step includes every stylesheet linked by the shipped dashboard',async t=>{
 const root=resolve(import.meta.dirname,'..'),out=await mkdtemp(join(tmpdir(),'voice-ui-build-'));t.after(()=>rm(out,{recursive:true,force:true}));
 const code=readFileSync(join(root,'scripts/build-public.mjs'),'utf8'),at=code.indexOf('voice-design.css'),start=code.lastIndexOf('\n',at)+1,end=code.indexOf('\nconst componentDescriptor=',at);assert.ok(at>0&&end>start);
 vm.runInNewContext(code.slice(start,end),{root,out,join,copyFileSync});
 const html=readFileSync(join(out,'index.html'),'utf8'),styles=[...html.matchAll(/href="\.\/([^\"]+\.css)"/g)].map(match=>match[1]);
 assert.ok(styles.includes('voice-design.css'));for(const name of styles)assert.ok(existsSync(join(out,name)),name+' missing from the staged application');
});
