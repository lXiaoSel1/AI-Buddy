import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('the stage follows the visible background and paper dialogs inherit the host theme',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-color-fixture.mjs');
});

test('recording Cancel follows the stage palette while paper and voice controls keep the host palette',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-color-fixture.mjs',{entry:'recordingContrast'});
});

test('group round progress shows real member statuses and dismisses from Escape or outside',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-r15-stage-fixture.mjs');
});

test('the stage uses its foreground for live Auto and the shared capsules for proactive actions',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-r15-stage-fixture.mjs',{entry:'stageActions'});
});

test('conversation export uses the host receipt and stays silent if the save dialog is cancelled',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-r15-stage-fixture.mjs',{entry:'fileExport'});
});
