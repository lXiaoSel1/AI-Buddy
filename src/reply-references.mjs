const labels=['原文参考','原文出处','参考资料','参考来源','资料来源','来源','参考','reference','references','source','sources','citation'];
const referenceLabel=value=>labels.includes(value.trim().toLowerCase());
export function replyLinksRequested(value){
 const text=String(value??'');
 if(/(?:不要|不用|无需|别|去掉|移除|不需要)[^。！？\n]{0,16}(?:链接|网址|引用|来源)|\b(?:no|without|omit|remove|don't include)\b[^.!?\n]{0,20}\b(?:links?|urls?|sources?|references?)\b/iu.test(text))return false;
 return /(?:给我|发我|提供|附上|保留|显示|查看|要|需要)[^。！？\n]{0,20}(?:链接|网址|原文|出处|来源)|(?:原样|逐字|照抄|verbatim)|\b(?:give|send|include|provide|show|keep|need|want)\b[^.!?\n]{0,35}\b(?:links?|urls?|sources?|references?|original)\b/iu.test(text);
}
function linkAt(text,start){
 const end=text.indexOf(']',start+1);if(end<0)return {pending:true,label:text.slice(start+1)};
 const label=text.slice(start+1,end);if(text[end+1]!=='(')return {label,pending:end+1===text.length};
 let depth=1,at=end+2;
 for(;at<text.length;at++){if(text[at]==='\\'){at++;continue;}if(text[at]==='(')depth++;if(text[at]===')'&&!--depth)break;}
 if(depth)return {label,pending:true};
 const url=text.slice(end+2,at);return {label,end:at+1,url,web:/^https?:\/\/\S+$/iu.test(url)};
}
export function cleanDialogueReferences(value,{requestText='',preserveLiteral=false,final=true}={}){
 const text=String(value??'');if(preserveLiteral||replyLinksRequested(requestText))return text;
 let result='',at=0;
 while(at<text.length){
  const wrapper=['（','('].includes(text[at])?text[at]:null,start=wrapper?at+1:at;
  if(text[start]==='['){
   const link=linkAt(text,start),label=link.label.trim().toLowerCase(),possible=referenceLabel(label)||!final&&labels.some(item=>item.startsWith(label));
   if(possible&&link.pending&&!final)break;
   if(referenceLabel(label)&&link.web){at=link.end;if(wrapper&&text[at]===(wrapper==='（'?'）':')'))at++;continue;}
  }
  result+=text[at++];
 }
 result=result.replace(/(^|\n)[ \t]*(?:原文参考|原文出处|参考资料|参考来源|资料来源|来源|参考|references?|sources?)\s*[:：]\s*https?:\/\/[^\n]*(?=\n|$)/giu,'$1')
  .replace(/(?<!\])[（(]\s*https?:\/\/[^\s（）()]+\s*[）)]/giu,'');
 if(!final){const last=result.lastIndexOf('\n'),tail=result.slice(last+1);if(/^(?:\s*(?:原文参考|原文出处|参考资料|参考来源|资料来源|来源|参考|references?|sources?)\s*[:：]\s*h(?:t(?:t(?:p(?:s?(?::(?:\/(?:\/[^\n]*)?)?)?)?)?)?)?)$/iu.test(tail))result=result.slice(0,last+1);}
 return result===text?text:result.replace(/[ \t]+([，。！？；：、])/gu,'$1').replace(/\n{3,}/gu,'\n\n').trimEnd();
}
export function speechLinkLabels(value){
 return String(value??'').replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s]+\)/giu,'$1').replace(/<?https?:\/\/[^\s<>）]+>?/giu,'');
}
