import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('the group roster is a searchable anchored popover with keyboard and outside dismissal',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-members-fixture.mjs');
});
