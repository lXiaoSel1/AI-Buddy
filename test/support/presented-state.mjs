// Simulates an unobstructed client acknowledging the rendered reply. Tests for
// modal/stop/restart boundaries deliberately use raw companion-state instead.
export async function presentedState(game){
 let state=(await game.action('companion-state')).companion;
 if(state.groupRuntime?.pendingMessage){await game.action('companion-group-present',{id:state.activeGroupId,requestId:state.groupRuntime.pendingMessage.id});state=(await game.action('companion-state')).companion;}
 if(!state.activeGroupId){const last=state.messages?.at(-1);if(last?.role==='assistant'&&last.presentation==='pending'){await game.action('companion-private-present',{conversationId:state.activeConversationId,id:last.id});state=(await game.action('companion-state')).companion;}}
 return state;
}
