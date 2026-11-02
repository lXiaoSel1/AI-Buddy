import test from 'node:test';
import assert from 'node:assert/strict';
import {safeSearchUrl} from '../src/native-search.mjs';
import {publicLinkUrl,pluginWindowOpenHandler,createExternalLinkBudget,LINK_BUDGET_LIMIT} from '../src/dsh-platform/client-host.mjs';

test('public links normalize DNS root dots and encoded hosts before local address checks',()=>{
 const denied=['https://localhost./','https://LOCALHOST./','https://sub.localhost./','https://printer.local./','https://PRINTER.LOCAL./','https://%6cocalhost./','https://printer.%6cocal./','http://127.0.0.1./','http://127.1/','http://2130706433/','http://0x7f000001/','http://%31%32%37.0.0.1/','http://0300.0250.1.1/','http://[::ffff:127.0.0.1]/','https://example.com../'];
 for(const url of denied){assert.equal(safeSearchUrl(url),null,url);assert.equal(publicLinkUrl(url),null,url);}
 for(const url of ['https://EXAMPLE.COM./a','https://%65xample.com./a']){assert.equal(safeSearchUrl(url),'https://example.com/a');assert.equal(publicLinkUrl(url),'https://example.com/a');}
});

test('public links retain protocol, credentials and private network refusals',()=>{
 for(const url of ['file:///C:/private','javascript:alert(1)','buddy://private','https://user:pass@example.com/','https://example.com/?access_token=not-a-secret','http://10.0.0.1/','http://192.168.1.1/','http://172.16.0.1/','http://intranet./','http://[::1]/'])assert.equal(publicLinkUrl(url),null,url);
 assert.equal(publicLinkUrl('https://example.com/help#section'),'https://example.com/help#section');
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('shared production budget bounds system browser handoffs across separate pages',async()=>{
 const opened=[],audit=[];let clock=0;
 const page=()=>pluginWindowOpenHandler({openExternal:async url=>opened.push(url),audit:value=>audit.push(value),now:()=>clock});
 const first=page(),second=page(),work=page();
 for(let i=0;i<LINK_BUDGET_LIMIT+5;i++){clock=i*1000;[first,second,work][i%3]({url:'https://example.com/help'});}
 await settle();assert.equal(opened.length,LINK_BUDGET_LIMIT);assert.equal(audit.length,1);assert.deepEqual(audit[0],{type:'plugin-external-link-denied',code:'PLUGIN_EXTERNAL_LINK_RATE_LIMIT',limit:10,windowMs:60000});
 assert.ok(!JSON.stringify(audit).includes('example.com'),'audit does not retain URL or its query');
});
test('rolling budget recovers, page throttle remains, and invalid links consume no global quota',async()=>{
 let clock=0;const opened=[],audit=[],budget=createExternalLinkBudget({limit:2,windowMs:60000,now:()=>clock});let closed=false;
 const make=()=>pluginWindowOpenHandler({openExternal:async url=>opened.push(url),audit:value=>audit.push(value),now:()=>clock,budget,isClosed:()=>closed});const a=make(),b=make();
 a({url:'file:///C:/x'});a({url:'https://example.com/form',postBody:{data:[]}});a({url:'https://example.com/1'});a({url:'https://example.com/throttled'});b({url:'https://example.com/2'});clock=1000;a({url:'https://example.com/blocked'});b({url:'https://example.com/blocked'});await settle();assert.equal(opened.length,2);assert.equal(audit.length,1);
 clock=60000;a({url:'https://example.com/after-window'});await settle();assert.equal(opened.length,3);
 clock=61000;a({url:'https://example.com/closed-before-handoff'});closed=true;await settle();assert.equal(opened.length,3);
});
