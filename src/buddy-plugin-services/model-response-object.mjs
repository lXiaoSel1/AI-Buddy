export function parseModelResponseObject(text){
 if(typeof text!=='string')return null;
 const source=text.trim(),fence=/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
 try{const value=JSON.parse(fence?fence[1]:source);return value!==null&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}
}
