const readyStages=new Set(['ready','active','activated','reused','reuse-existing','activation-confirmed-query-pending']);

export function cloudVoiceReady(status){
  return readyStages.has(status);
}
