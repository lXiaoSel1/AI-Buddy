// A device-output preference only; it never changes PCM, timing or receipts.
export function createCardVoiceMix(){
 let value={voice:1,muted:false};const nodes=new Map();
 const collect=()=>{for(const [context,node] of nodes)if(context.state==='closed'){try{node.disconnect();}catch{}nodes.delete(context);}};
 const set=next=>{if(!Number.isFinite(next?.voice)||next.voice<0||next.voice>1||typeof next.muted!=='boolean')return false;value={voice:next.voice,muted:next.muted};collect();for(const node of nodes.values())node.gain.value=value.muted?0:value.voice;return true;};
 return {set,destination(context,channel){if(channel!=='card-table')return context.destination;collect();let node=nodes.get(context);if(!node){node=context.createGain();node.connect(context.destination);nodes.set(context,node);}node.gain.value=value.muted?0:value.voice;return node;},close(){for(const node of nodes.values())try{node.disconnect();}catch{}nodes.clear();}};
}
