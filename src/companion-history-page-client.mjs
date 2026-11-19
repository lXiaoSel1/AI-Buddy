import {useEffect,useLayoutEffect,useRef,useState} from 'react';

const PAGE_SIZE=50;
export const historyMessageKey=message=>message.occurrenceId??message.id;

export function useCompanionHistoryPage({request,ownerType,ownerId,search='',favorites=false,initial=[],currentRevision}){
 const key=JSON.stringify([ownerType,ownerId,search,favorites]);
 const [result,setResult]=useState(null),[pending,setPending]=useState(false),[error,setError]=useState(null),[reload,setReload]=useState(0);
 const source=useRef(request),scope=useRef(key),sequence=useRef(0),running=useRef(false),position=useRef(null),renderedRevision=useRef(currentRevision);
 const scrollRef=useRef(null),listRef=useRef(null);
 source.current=request;scope.current=key;
 const page=result?.key===key?result:null;
 const failure=error?.key===key?error.reason:null;

 async function read(before){
  const run=++sequence.current;
  running.current=true;
  setPending(true);setError(null);
  try{
   const value=await source.current('companion-history-page',{ownerType,ownerId,before,limit:PAGE_SIZE,search,favorites});
   if(run!==sequence.current||scope.current!==key)return;
   if(value?.ok===false||!Array.isArray(value?.messages))throw Error(value?.error||'读取中断，请重试。');
   const scroller=scrollRef.current;
   if(before&&scroller){
    const {top,bottom}=scroller.getBoundingClientRect();
    const anchor=[...(listRef.current?.querySelectorAll('[data-history-message-id]')??[])].find(node=>{
     const rect=node.getBoundingClientRect();
     return rect.bottom>top&&rect.top<bottom;
    });
    position.current={key,height:scroller.scrollHeight,top:scroller.scrollTop,anchor,offset:anchor?.getBoundingClientRect().top};
   }else position.current={key,last:true};
   setResult(previous=>{
    const older=previous?.key===key ? previous.messages : [];
    const seen=new Set(older.map(historyMessageKey));
    const messages=before?[...value.messages.filter(message=>!seen.has(historyMessageKey(message))),...older]:value.messages;
    return {...value,key,messages};
   });
  }catch(reason){
   if(run===sequence.current&&scope.current===key)setError({key,reason});
  }finally{
   if(run===sequence.current&&scope.current===key){running.current=false;setPending(false);}
  }
 }

 useEffect(()=>{
  if(!ownerId)return;
  renderedRevision.current=currentRevision;
  const delay=search?180:0;
  const timer=setTimeout(()=>void read(),delay);
  return()=>{sequence.current++;running.current=false;clearTimeout(timer);};
 },[key,reload]);

 useLayoutEffect(()=>{
  const desired=position.current,node=scrollRef.current;
  if(desired?.key!==key||!node||!page)return;
  position.current=null;
  if(desired.last){node.scrollTop=node.scrollHeight;return;}
  if(desired.anchor?.isConnected&&Number.isFinite(desired.offset)){
   node.scrollTop+=desired.anchor.getBoundingClientRect().top-desired.offset;
  }else node.scrollTop=desired.top+node.scrollHeight-desired.height;
 },[key,page]);

 useEffect(()=>{
  if(renderedRevision.current===currentRevision)return;
  renderedRevision.current=currentRevision;
  const scroller=scrollRef.current;
  if(page&&page.messages.length<=PAGE_SIZE&&!running.current&&scroller
    &&scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<40)setReload(value=>value+1);
 },[currentRevision]);

 const loadOlder=()=>{if(!running.current&&page?.hasMore&&page.nextBefore)void read(page.nextBefore);};
 const onScroll=event=>{if(!failure&&event.currentTarget.scrollTop<=28&&event.currentTarget.scrollHeight>event.currentTarget.clientHeight)loadOlder();};
 const updateMessage=(id,patch)=>{
  setResult(previous=>{
   if(previous?.key!==key)return previous;
   const messages=previous.messages.map(message=>historyMessageKey(message)===id?{...message,...patch}:message);
   if(favorites&&patch.favorite===false)return {...previous,totalCount:Math.max(0,previous.totalCount-1),messages:messages.filter(message=>historyMessageKey(message)!==id)};
   return {...previous,messages};
  });
 };
 const fallback=search?[]:favorites?initial.filter(message=>message.favorite):initial;
 return {messages:page?.messages??fallback,totalCount:page?.totalCount??fallback.length,hasMore:page?.hasMore??false,
  pending:pending&&!failure,error:failure,scrollRef,listRef,onScroll,loadOlder,updateMessage,
  retry:()=>page?.hasMore?loadOlder():setReload(value=>value+1)};
}
