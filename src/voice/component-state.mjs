// Shared by the trusted read-only gateway and installed voice presentation.
export function voiceComponentSummary({asr,tts}={}){
  const states=[asr?.state,tts?.state],ready=states.every(state=>['ready','not-required'].includes(state));
  const state=ready?'ready':states.includes('preparing')?'preparing':states.includes('verification-needed')?'verification-needed':states.includes('error')?'error':states.includes('unavailable')?'unavailable':'missing';
  return {asr,tts,ready,state};
}
