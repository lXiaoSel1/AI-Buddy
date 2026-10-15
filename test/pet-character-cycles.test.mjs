import test from 'node:test';
import assert from 'node:assert/strict';
const ids=['idle','wave','jump','fail','look','waiting','working','reviewing','move-left','move-right'];
const table=duration=>Object.fromEntries(ids.map(id=>[id,{actionId:id,cycleMs:duration,frames:[{timestampMs:0},{timestampMs:duration/2}]}]));
globalThis.__PET_CHARACTER_SEQUENCES__={deepseek:table(1000),claude:table(1600),qwen:table(800)};
const {activatePetCharacter}=await import('../src/frame-sequence.mjs');
const {getPetAction,PetActionController,validatePetPlayback}=await import('../src/pet-actions.mjs');

test('Feedback uses the active character duration and retains two full jumps across pauses',()=>{
 activatePetCharacter('claude');let time=0;const c=new PetActionController({now:()=>time});
 c.enqueueFeedback({eventId:'finish',source:'completed',id:'jump',text:'Done'});assert.equal(c.select().feedback.duration,3200);
 time=700;c.drag(true);time=1700;assert.equal(c.select().feedback.elapsed,700);c.drag(false);time=4200;assert.equal(c.select().id,'idle');
 activatePetCharacter('qwen');c.enqueueFeedback({eventId:'finish2',source:'completed',id:'jump'});assert.equal(c.select().feedback.duration,1600);
 assert.equal(getPetAction('jump','claude').cycleMs,1600);assert.equal(validatePetPlayback({id:'jump',characterId:'claude'}).characterId,'claude');
});

test('Resource preparation holds an unstarted feedback without consuming its duration',()=>{
 activatePetCharacter('deepseek');let time=0;const c=new PetActionController({now:()=>time});c.holdFeedback=true;
 c.enqueueFeedback({eventId:'queued',source:'completed',id:'jump'});time=5000;assert.equal(c.select().feedback,null);assert.equal(c.feedback.queue.length,1);
 activatePetCharacter('claude');c.holdFeedback=false;assert.equal(c.select().feedback.elapsed,0);assert.equal(c.select().feedback.duration,3200);
 time=5800;assert.equal(c.select().feedback.elapsed,800);c.setSpeed(.5);time=6600;assert.equal(c.select().feedback.elapsed,1200);
});
