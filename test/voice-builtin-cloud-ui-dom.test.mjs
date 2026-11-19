import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('built-in cloud settings and group chat complete account, consent and ASR actions using synthetic service results',{timeout:30000},async t=>{
 await runGalgameDom(t,'./voice-builtin-cloud-ui-fixture.mjs',{entry:'verify'});
});

test('auto retention holds give visible recovery and suppress duplicate manual attempts',{timeout:30000},async t=>{
 await runGalgameDom(t,'./voice-builtin-cloud-ui-fixture.mjs',{entry:'verifyRetention'});
});

test('cloud settings reset explains what can be recovered from MiniMax',{timeout:30000},async t=>{
 await runGalgameDom(t,'./voice-builtin-cloud-ui-fixture.mjs',{entry:'verifyResetCopy'});
});

test('only a checked missing activation can be explicitly abandoned',{timeout:30000},async t=>{
 await runGalgameDom(t,'./voice-builtin-cloud-ui-fixture.mjs',{entry:'verifyAbandonActivation'});
});
