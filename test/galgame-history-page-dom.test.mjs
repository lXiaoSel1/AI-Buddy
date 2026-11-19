import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('private history pages independently of the 60-session metadata sidebar',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-history-page-fixture.mjs',{scenario:'idle',entry:'privateHistory'});
});
test('group history pages backwards and searches past the current stage slice',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-history-page-fixture.mjs',{scenario:'idle',entry:'groupHistory'});
});

test('English group history displays a clean SQLite export error',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-history-page-fixture.mjs',{scenario:'idle',entry:'groupExportError'});
});
