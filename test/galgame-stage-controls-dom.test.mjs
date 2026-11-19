import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('the character owns the dialogue nameplate while a real UI send waits for the model',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'idle',entry:'thinking'});
});

test('the private menu shows the real positive gallery count and omits zero',{timeout:48000},async t=>{
 for(const count of [3,0])await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'idle',galleryCount:count,entry:'gallery'});
});

test('background picker has the approved columns, actual options and override state',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'cg',entry:'background'});
});

test('portrait picker has the approved canvas, conditions and disabled initial apply',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'idle',entry:'portrait'});
});

test('expanded private composer leaves all three choices visible and clickable',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-overlap',entry:'composerChoices'});
});

test('expanded group composer keeps Continue visible and clickable',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-input',entry:'groupComposer'});
});

test('mood popover opens downward within the stage and leaves the composer reachable',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-overlap',entry:'moodLayer'});
});

test('dark group stage uses its own ink for offline, Voice and Auto status',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-offline',entry:'stageStatusContrast'});
});

test('stage error ink follows both schemes while paper and workspace keep theme ink',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{entry:'stageErrorAndPaperContrast'});
});

test('dark group composer keeps the first-turn helper readable',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-hint',entry:'groupHintInk'});
});

test('active Auto badge and round recap follow the dark group stage palette',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-auto',entry:'activeAutoInk'});
});

test('group composer leaves the full Auto button clickable at normal and narrower stage widths',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-hint',entry:'groupAutoHit'});
});

test('active Auto Stop and the group toolbar remain independently clickable with an expanded composer',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-auto',entry:'activeAutoStopHit'});
});

test('group recording keeps Auto and recording Cancel clickable',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-recording',entry:'groupRecordingHit'});
});

test('long private and group dialogue fit inside 30 percent of the stage',{timeout:48000},async t=>{
 for(const channel of ['private','group'])await t.test(channel,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-'+channel+'-long',entry:'longDialogue'});
 });
});

test('private bottom controls leave room for choices and a growing composer',{timeout:55000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-private-layout',entry:'privateLayout'});
});

test('group Auto status and bottom controls are independently reachable',{timeout:100000},async t=>{
 for(const state of ['auto-layout','ended'])await t.test(state,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-'+state,entry:'groupBottomLayout'});
 });
});

test('private and group recording controls remain reachable at each stage width',{timeout:100000},async t=>{
 for(const channel of ['private','group'])await t.test(channel,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-'+channel+'-recording-layout',entry:'recordingLayout'});
 });
});

test('short frameless and long classic replies retain their original controls',{timeout:55000},async t=>{
 for(const stage of ['short-layout','private-classic'])await t.test(stage,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-'+stage,entry:'shortAndClassic'});
 });
});

test('ended Auto recap and full-message action are legible on opposite-scheme group stages',{timeout:48000},async t=>{
 for(const inverse of [false,true])await t.test(inverse?'dark theme on light scene':'light theme on dark scene',async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-ended-'+(inverse?'light-':'')+'long',galleryCount:Number(inverse),entry:'endedStageContrast'});
 });
});

test('V6 dialogue and composer match the approved stage geometry',{timeout:55000},async t=>{
 for(const channel of ['private','group'])await t.test(channel,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-'+channel+'-long',entry:'approvedStageGeometry'});
 });
});

test('Galgame voice switch and separate start show four states in frameless and classic chat',{timeout:48000},async t=>{
 for(const style of ['frameless','classic'])await t.test(style,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-voice-'+style,entry:'voiceStartStates'});
 });
});

test('V6 portrait geometry matches the prior stage',{timeout:60000},async t=>{
 for(const channel of ['private','group'])await t.test(channel,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-'+channel+'-portrait-layout',entry:'approvedPortraitGeometry'});
 });
});

test('V6 dense stage preserves wrapped actions and the five-line draft inside the bottom budget',{timeout:110000},async t=>{
 for(const [label,scenario] of [['private','stage-private-dense-long'],['group','stage-group-ended-long']])await t.test(label,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario,entry:'approvedDenseGeometry'});
 });
});

test('V6 English stopped and dubbing failure footer stays reachable within the dense stage budget',{timeout:55000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-private-dense-long',entry:'approvedDenseGeometry',galleryCount:1});
});

test('V6 minimum group stage keeps Auto controls and the member popup usable',{timeout:25000},async t=>{
 for(const [name,kind] of [['running Auto',0],['member popup',1]])await t.test(name,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-auto-compact-layout',entry:'compactGroupOverlays',galleryCount:kind});
 });
});

test('V6 compact Auto retains controls and error details after a real pause rejection',{timeout:25000},async t=>{
 for(const [locale,english] of [['Chinese',0],['English',1]])await t.test(locale,async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-group-auto-compact-layout',entry:'compactAutoError',galleryCount:english});
 });
});

test('V6 first-row stage popovers receive their controls at the normal and minimum sizes',{timeout:30000},async t=>{
 for(const width of [944,600])await t.test(String(width),async child=>{
  await runGalgameDom(child,'./galgame-stage-controls-fixture.mjs',{scenario:'stage-voice-frameless',entry:'topStagePopovers',galleryCount:width});
 });
});
