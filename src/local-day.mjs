export function localDay(at,{padded=true}={}){
 const date=new Date(at);if(!Number.isFinite(date.getTime()))throw Error('Invalid local date');
 const part=value=>padded?String(value).padStart(2,'0'):String(value);
 return [date.getFullYear(),part(date.getMonth()+1),part(date.getDate())].join('-');
}
