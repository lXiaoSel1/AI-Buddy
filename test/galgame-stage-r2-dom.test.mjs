import test from 'node:test';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

for(const [issue,scenario,entry,galleryCount] of [
 ['U3 proactive options remain reachable','stage-private-r2-proactive','r2Proactive'],
 ['U4 private reply follows stream until the reader scrolls away','stage-private-r2-stream','r2Stream'],
 ['U4 group reply follows stream until the reader scrolls away','stage-group-r2-stream','r2Stream'],
 ['U4 private narration reveals the current sentence tail','stage-private-r2-narration','r2Narration'],
 ['U4 group narration reveals the current sentence tail','stage-group-r2-narration','r2Narration'],
 ['U3/U4 proactive narration keeps options accessible and follows the current sentence','stage-private-r2-narration-proactive','r2Narration',1],
 ['U5 live font settings preserve the stage dialogue budget','stage-private-r2-font-long','r2Font'],
 ['U6 group viewing toolbar clears other controls at each stage size','stage-group-r2-layout','r2Group'],
 ['Compact stage history and status align','stage-group-r2-layout','r2Compact'],
 ['Compact private Live keeps history and status aligned','stage-private-recording-layout','r2CompactLive'],
 ['Mood popover stacks above group feedback','stage-group-r2-layout','r2Mood'],
])test(issue,{timeout:55000},async t=>{
 await runGalgameDom(t,'./galgame-stage-controls-fixture.mjs',{scenario,entry,galleryCount});
});
