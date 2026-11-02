import {filterReplySourceLabels,createReplySourceFilter} from './reply-source-labels.mjs';
export function visibleCompanionText(message,{messages=[]}={}){
 const text=String(message?.text??'');if(message?.role!=='assistant'&&message?.who!=='heroine')return text;
 const request=message.request??{};let requestText=request.inputUserText??'';
 if(!requestText){const index=messages.findIndex(row=>row===message||row.id&&row.id===message.id);for(let i=index-1;i>=0;i--)if(messages[i].role==='user'){requestText=messages[i].text??'';break;}}
 return filterReplySourceLabels(text,{preserveLiteral:request.preserveSourceLiteral===true,requestText});
}
export function visibleInterruptedText(record,{requestText=''}={}){
 if(!record)return '';
 if(Object.hasOwn(record,'visibleText'))return typeof record.visibleText==='string'?record.visibleText:'';
 return createReplySourceFilter({requestText}).feed(String(record.text??''));
}
