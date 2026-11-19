import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('Galgame waits for storage migration, shows progress and reloads the restored view',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-migration-fixture.mjs',{scenario:'migration'});
});
