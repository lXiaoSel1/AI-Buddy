import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('IPC rejections show only a localized reason in Galgame error surfaces',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-ipc-error-fixture.mjs');
});

test('group photo opens the saved image without drawing and regenerates only the selected cast',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-ipc-error-fixture.mjs',{entry:'runSavedGroupPhoto'});
});
