export function cleanIpcMessage(message){
 return String(message??'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
}
