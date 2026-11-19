import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('the recorded group-chat draft source and one keyboard hint are visible',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-voice-draft-fixture.mjs');
});

test('reduced motion stops stage animations while preserving static indicators',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-reduced-motion-fixture.mjs',{reducedMotion:true});
});
