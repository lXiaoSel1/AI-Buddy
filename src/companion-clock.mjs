export function companionClockPrompt(language){
 const english=language==='en';
 return at=>{
  const format=new Intl.DateTimeFormat(english?'en-US':'zh-CN',{
   calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',
   weekday:english?'short':'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  });
  const {timeZone}=format.resolvedOptions();
  const parts=Object.fromEntries(format.formatToParts(at).map(({type,value})=>[type,value]));
  const date=parts.year+'-'+parts.month+'-'+parts.day,time=parts.hour+':'+parts.minute;
  return english
   ?'Current local time: '+date+' ('+parts.weekday+') '+time+' ('+timeZone+')\nUse this system clock when relevant. Story time and historical timestamps describe their own events. The clock alone does not say what the user has done or plans to do.'
   :'当前本地时间：'+date+'（'+parts.weekday+'）'+time+'（'+timeZone+'）\n这是系统本地时钟，需要时参考。剧情和历史消息的时间只描述各自的事件。不要仅凭现在几点推断用户已经做过什么或接下来会做什么。';
 };
}
