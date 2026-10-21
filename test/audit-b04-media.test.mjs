import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createMediaStore,mediaName,canonicalImage,resolveStateImages} from '../src/media-store.mjs';
import {createDraftStore} from '../src/draft-store.mjs';
import {openCompanionStore,makeCard} from '../src/companion-store.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {tmpDir,syntheticEngine,companionFixture,copy} from './support/audit-harness.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=','base64');
const BIG=Buffer.concat([PNG,Buffer.alloc(2*1024*1024,7)]);
const url=bytes=>'data:image/png;base64,'+bytes.toString('base64');
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),runTurn:async fn=>fn(),resolveContextCapacity:()=>({tokens:8192,source:'fixture',verified:true})};
const companionFile=root=>join(root,'galgame','companion.json');
async function seeded(t,mutate=()=>{}){
 const root=tmpDir('b04',{t}),state=await companionFixture();mutate(state);
 await createSnapshotStorage(companionFile(root)).writeText(JSON.stringify(state));return root;
}
async function launch(root,{hooks={}}={}){
 const media=createMediaStore(root),drafts=createDraftStore(root),store=await openCompanionStore(root,{media}),registered=[];
 const {engine}=syntheticEngine({getStore:()=>store,hooks:{call(action,args){if(action==='companion-register'){registered.push(args.card);return {ok:true};}return hooks.call?.(action,args);}}});
 const service=await createCompanionService({store,engine,provider,dataRoot:root,now:Date.now,media,drafts,imageCodec:()=>({})});
 return {media,drafts,store,service,registered,close:async()=>{service.close();await store.flush();}};
}

test('B4: media names are content hashes; only canonical image data URLs become files',t=>{
 const root=tmpDir('b04-store',{t}),media=createMediaStore(root),ref=media.put(url(PNG));
 assert.match(ref,/^buddy-media:\/\/[a-f0-9]{64}\.png$/);assert.equal(media.resolve(ref),url(PNG));assert.equal(media.put(url(PNG)),ref,'same bytes, same file');
 assert.equal(media.put('data:image/png;base64,'+PNG.toString('base64').replace(/(.{20})/,'$1\n')),null,'not canonical');assert.equal(media.put('data:image/gif;base64,R0lGODlh'),null);
 assert.equal(canonicalImage('data:image/png;base64,'),false);
 for(const bad of ['buddy-media://../x.png','buddy-media://'+'A'.repeat(64)+'.png','buddy-media://'+'a'.repeat(64)+'.exe','file:///c:/x.png'])assert.equal(mediaName(bad),null,bad);
 assert.equal(mediaName(ref+'/'),ref.slice('buddy-media://'.length),'a standard-scheme URL may end with a slash');
 assert.equal(media.resolve('buddy-media://'+'b'.repeat(64)+'.png'),'','a missing file resolves to empty');
});

test('B4: a newly set picture is stored as a file, the engine still receives a data URL, and companion.json stays small',async t=>{
 const root=await seeded(t),app=await launch(root);t.after(app.close);
 await app.service.action('companion-character-save',{...copy(app.store.state.cards.claude),fields:{...app.store.state.cards.claude.fields,sprite:{mode:'custom',value:url(BIG)}},avatar:url(BIG)});
 const card=app.store.state.cards.claude;
 assert.match(card.avatar,/^buddy-media:\/\//);assert.match(card.fields.sprite.value,/^buddy-media:\/\//);assert.equal(card.avatar,card.fields.sprite.value);
 assert.equal(readdirSync(app.media.directory).length,1);
 assert.equal(app.registered.at(-1).effective.sprite,url(BIG),'the engine keeps reading a data URL');
 await app.store.flush();assert.ok(JSON.stringify(await readJson(createSnapshotStorage(companionFile(root)))).length<200*1024);
 assert.ok(makeCard({...card,fields:{sprite:{mode:'custom',value:card.fields.sprite.value}}},card),'a media URL is a valid picture value');
});

test('B4: pictures already in the store stay until migrated, and a store change serializes once with the revision first',async t=>{
 const root=await seeded(t,state=>{state.personas.default.avatar=url(PNG);}),app=await launch(root);t.after(app.close);
 await app.service.action('companion-title-set',{characterId:'claude',title:'新标题'});await app.store.flush();
 assert.equal(app.store.state.personas.default.avatar,url(PNG));
 assert.equal(Object.keys(await readJson(createSnapshotStorage(companionFile(root))))[0],'revision');
 const revision=app.store.state.revision;await app.service.action('companion-title-set',{characterId:'claude',title:'新标题'});assert.equal(app.store.state.revision,revision,'no change, no write');
});

test('B4: drafts are kept out of the companion store and survive a restart',async t=>{
 const root=await seeded(t),first=await launch(root),id=first.store.state.activeConversationId,revision=first.store.state.revision;
 const view=await first.service.action('companion-conversation-update',{id,draft:'还没写完的一句'});
 assert.equal(first.store.state.revision,revision,'typing a draft does not write companion.json');
 assert.equal(view.companion.draft??view.companion.conversation?.draft??(await first.service.action('companion-state')).companion.draft,'还没写完的一句');
 await first.close();assert.equal(JSON.parse(readFileSync(join(root,'galgame','drafts.json'),'utf8')).drafts[id],'还没写完的一句');
 const second=await launch(root);t.after(second.close);
 assert.equal((await second.service.action('companion-state')).companion.draft,'还没写完的一句');
});

test('B4: exports carry the picture bytes, not media URLs',async t=>{
 const root=await seeded(t),app=await launch(root);t.after(app.close);
 await app.service.action('companion-persona-save',{id:'default',name:'默认身份',avatar:url(PNG)});
 assert.match(app.store.state.personas.default.avatar,/^buddy-media:\/\//);
 const {data}=await app.service.action('companion-conversation-export',{});
 assert.equal(data.personas.default.avatar,url(PNG));assert.doesNotMatch(JSON.stringify(data),/buddy-media:/);
});

test('B4: a life archive packs media pictures and restoring brings them back as files',async t=>{
 const root=await seeded(t),app=await launch(root,{hooks:{call(action){if(action==='companion-life-project')return {ok:true};}}});t.after(app.close);
 await app.service.action('companion-character-save',{...copy(app.store.state.cards.claude),avatar:url(PNG)});
 const archive=(await app.service.action('companion-life-save',{characterId:'claude'})).archive;assert.ok(archive.id);
 await app.service.action('companion-life-reset',{characterId:'claude',mode:'normal'});
 await app.service.action('companion-life-restore',{id:archive.id});
 assert.match(app.store.state.cards.claude.avatar,/^buddy-media:\/\//);assert.equal(app.media.resolve(app.store.state.cards.claude.avatar),url(PNG));
});

test('T2: migration moves canonical pictures, keeps the rest, and expands back to the identical store; revert undoes it',async t=>{
 const odd='data:image/png;base64,'+PNG.toString('base64').replace(/(.{20})/,'$1\n');
 const root=await seeded(t,state=>{state.personas.default.avatar=url(PNG);state.cards.claude.avatar=url(BIG);state.cards.gpt.avatar=odd;}),app=await launch(root);t.after(app.close);
 const before=copy(app.store.state),maintenance=app.service.maintenance;
 const plan=maintenance.plan('media-migrate');assert.equal(plan.total,2);assert.equal(plan.skipped,1);
 const result=await maintenance.apply('media-migrate',plan.planId);
 assert.match(app.store.state.cards.claude.avatar,/^buddy-media:\/\//);assert.equal(app.store.state.cards.gpt.avatar,odd);
 const {revision,...expanded}=resolveStateImages(app.media,app.store.state),{revision:old,...original}=before;assert.deepEqual(expanded,original);
 assert.deepEqual(JSON.parse(readFileSync(result.backup,'utf8')),before,'the backup is the store before the change');
 assert.equal(maintenance.plan('media-migrate').total,0);
 const id=app.store.state.activeConversationId;await app.service.action('companion-conversation-update',{id,draft:'草稿'});
 const back=maintenance.plan('media-revert');assert.equal(back.total,2);assert.equal(back.drafts,1);
 await maintenance.apply('media-revert',back.planId);
 assert.equal(app.store.state.cards.claude.avatar,url(BIG));assert.equal(app.store.state.personas.default.avatar,url(PNG));assert.equal(app.store.state.conversations[id].draft,'草稿');
 assert.deepEqual(app.drafts.entries(),[]);
 await app.service.action('companion-title-set',{characterId:'claude',title:'x'});assert.equal(app.store.state.cards.claude.avatar,url(BIG),'an unrelated change does not move it again');
});
