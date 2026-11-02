// README text of a work (approved design B2 「介绍」): a small Markdown subset turned into React elements.
// There is no HTML path at all: raw tags show as text, nothing is injected, images are not loaded (the page
// allows no remote images), and a link is a button that asks the host to open it (onLink), never a navigation.
// Review 中-4: parsing is linear in the text (no regex backtracking; every closing-mark search is cached so a run of
// unclosed marks costs one pass), nesting is capped, and the result is memoized per text.
import React,{useMemo,useRef} from 'react';
const h=React.createElement;
export function markdownHref(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
const MAX_DEPTH=2,MAX_NODES=4000,MAX_BLOCKS=2000,URL_END=new Set([' ','\t','<','>','(',')','"','\'']);
// finder(text)(mark, from): first index >= from, remembering the last answer per mark so repeated failures stay linear.
function finder(text){const seen=new Map();return (mark,from)=>{const last=seen.get(mark);if(last&&last.from<=from&&(last.at===-1||last.at>=from))return last.at;const at=text.indexOf(mark,from);seen.set(mark,{from,at});return at;};}
function link(label,href,onLink,key){
 const target=markdownHref(href);if(!target||!onLink)return h('span',{key},label);
 let host='';try{host=new URL(target).host;}catch{}
 // review 低-3: when the text is not the address itself, the target host is shown next to it
 return h('button',{key,type:'button',className:'ext-mdlink',title:target,onClick:()=>onLink(href)},label,label!==href&&host&&h('small',{className:'ext-mdhost'},' ('+host+')'));
}
// budget: formatted nodes per README, so the element count stays bounded too; past it the rest shows as plain text.
function inline(text,onLink,key,depth=0,budget={nodes:MAX_NODES}){
 const out=[],find=finder(text);let plain='',n=0,i=0;
 const flush=()=>{if(plain){out.push(plain);plain='';}},push=node=>{flush();out.push(node);budget.nodes--;};
 while(i<text.length){
  const c=text[i],k=key+'.'+n++;
  if(budget.nodes<=0){plain+=text.slice(i);break;}
  if(c==='`'){const close=find('`',i+1);if(close>i+1){push(h('code',{key:k},text.slice(i+1,close)));i=close+1;continue;}}
  else if((c==='*'||c==='_')&&text[i+1]===c){const close=find(c+c,i+2);if(close>i+2&&depth<MAX_DEPTH){push(h('strong',{key:k},inline(text.slice(i+2,close),onLink,k,depth+1,budget)));i=close+2;continue;}}
  else if((c==='*'||c==='_')&&text[i+1]&&text[i+1]!==' '&&text[i+1]!==c){const close=find(c,i+1);if(close>i+1&&depth<MAX_DEPTH){push(h('em',{key:k},inline(text.slice(i+1,close),onLink,k,depth+1,budget)));i=close+1;continue;}}
  else if(c==='['||c==='!'&&text[i+1]==='['){const open=c==='!'?i+1:i,close=find(']',open+1);
   if(close>open&&text[close+1]==='('){const end=find(')',close+2),href=end>close+2?text.slice(close+2,end):'';if(href&&!/\s/.test(href)){push(link(text.slice(open+1,close)||href,href,onLink,k));i=end+1;continue;}}}
  else if(c==='h'&&(text.startsWith('https://',i)||text.startsWith('http://',i))){let end=i;while(end<text.length&&!URL_END.has(text[end]))end++;while(end>i&&'.,;:!?'.includes(text[end-1]))end--;const href=text.slice(i,end);if(markdownHref(href)){push(link(href,href,onLink,k));i=end;continue;}}
  plain+=c;i++;
 }
 flush();return out;
}
const special=line=>/^\s*(```|#{1,6}\s|>|[-*+]\s+|\d+[.)]\s+)/.test(line)||/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
const withoutComments=text=>{let out='',at=0;for(;;){const open=text.indexOf('<!--',at);if(open<0)return out+text.slice(at);const close=text.indexOf('-->',open+4);out+=text.slice(at,open);if(close<0)return out;at=close+3;}};
// 「## Title ##」: heading level and text without trailing marks, scanned by hand (no backtracking regex).
function heading(line){const m=/^\s*(#{1,6})\s+/.exec(line);if(!m)return null;let end=line.length;while(end>m[0].length&&(line[end-1]===' '||line[end-1]==='\t'||line[end-1]==='#'))end--;return {level:m[1].length,text:line.slice(m[0].length,end)};}
export function markdownBlocks(text,onLink){
 const lines=withoutComments(String(text??'')).replace(/\r\n?/g,'\n').split('\n'),blocks=[],budget={nodes:MAX_NODES},inl=(value,key)=>inline(value,onLink,key,0,budget);
 for(let i=0;i<lines.length;){
  const line=lines[i],key='b'+blocks.length;
  if(blocks.length>=MAX_BLOCKS){blocks.push(h('p',{key},lines.slice(i).join(' ')));break;}
  if(!line.trim()){i++;continue;}
  if(/^\s*```/.test(line)){const body=[];for(i++;i<lines.length&&!/^\s*```/.test(lines[i]);i++)body.push(lines[i]);i++;blocks.push(h('pre',{key},h('code',null,body.join('\n'))));continue;}
  const head=heading(line);
  if(head){blocks.push(h(['h3','h4','h5'][Math.min(head.level,3)-1],{key},inl(head.text,key)));i++;continue;}
  if(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)){blocks.push(h('hr',{key}));i++;continue;}
  if(/^\s*>/.test(line)){const body=[];for(;i<lines.length&&/^\s*>/.test(lines[i]);i++)body.push(lines[i].replace(/^\s*>\s?/,''));blocks.push(h('blockquote',{key},inl(body.join(' '),key)));continue;}
  const ordered=/^\s*\d+[.)]\s+/.test(line);
  if(ordered||/^\s*[-*+]\s+/.test(line)){const items=[],marker=ordered?/^\s*\d+[.)]\s+/:/^\s*[-*+]\s+/;
   for(;i<lines.length&&lines[i].trim();i++){if(marker.test(lines[i]))items.push(lines[i].replace(marker,''));else if(special(lines[i]))break;else if(items.length)items[items.length-1]+=' '+lines[i].trim();}
   blocks.push(h(ordered?'ol':'ul',{key},...items.map((item,n)=>h('li',{key:n},inl(item.replace(/^\[[ xX]\]\s+/,''),key+'.'+n)))));continue;}
  const body=[lines[i++].trim()];for(;i<lines.length&&lines[i].trim()&&!special(lines[i]);i++)body.push(lines[i].trim());
  blocks.push(h('p',{key},inl(body.join(' '),key)));
 }
 return blocks;
}
export function Markdown({text,onLink,className='ext-readme ext-md'}){
 const latest=useRef(onLink);latest.current=onLink;
 const blocks=useMemo(()=>markdownBlocks(text,onLink?href=>latest.current?.(href):null),[text,!onLink]);
 return h('div',{className},...blocks);
}
