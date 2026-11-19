// The worker accepts only these writes. Retry means the frozen request may
// run again after the original writer has exited without acknowledging it.
const retry=arity=>Object.freeze({arity,retry:true});
const receipt=arity=>Object.freeze({arity,retry:true,receipt:true});
const stop=arity=>Object.freeze({arity,retry:false});
const deal=Object.freeze({arity:1,retry:true,receipt:true,random:true});

export const economyWrites=Object.freeze({
 settings:retry(1),
 ensureScope:retry(1),
 getHunger:retry(2),
 mergeHunger:receipt(2),
 initializeRewards:receipt(1),
 ingestUsageFact:receipt(2),
 ingestUsageFacts:receipt(2),
 purchase:receipt(1),
 consume:receipt(1),
 purchaseAndConsumeRice:receipt(1),
 updateMeal:retry(2),
 saveAuto:retry(1),
 prepareLife:receipt(1),
 applyLife:receipt(1),
 finalizeLife:receipt(1),
 recoverLife:retry(1),
 rebindPendingMeals:retry(1),
 'games.ensure':retry(1),
 'games.welfare':receipt(2),
 'games.create':deal,
 'games.action':receipt(3),
 'games.control':receipt(2),
 'games.next':deal,
 'games.chat':receipt(1),
 'games.appendChat':receipt(1),
 'games.restoreAccount':receipt(1),
 'games.acknowledge':receipt(2),
 'games.binding':stop(1),
 'games.request':receipt(1),
 'games.recover':stop(0),
 // The archive insert ignores the same message ID; the head writes the same absolute value.
 'games.chatPage':retry(2),
 'games.registerRules':retry(1)
});
