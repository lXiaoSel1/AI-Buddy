export const SOCIAL_CONTRACT_VERSION='social-contract-v1';
export const SOCIAL_STORAGE_UNAVAILABLE='SOCIAL_STORAGE_UNAVAILABLE';
export const SOCIAL_ACCOUNTS_DATABASE='social-core/accounts-v1.sqlite';
export const SOCIAL_METHODS=Object.freeze(['social.context.read','models.request','activity.lease','activity.check','activity.finish','experience.append','proactive.offer','search.native','owner.work.propose','owner.work.read','owner.work.approve','owner.work.cancel']);
export const SOCIAL_CAPABILITIES=Object.freeze([...SOCIAL_METHODS,'connections.request','connections.open','connections.events','connections.close','ui.bubble','proactive.claim','tools.list','tools.invoke','notifications.publish','ui.registerPage','lifecycle.register']);
export const SOCIAL_IDENTITY_FIELDS=Object.freeze(['contextKind','channel','conversationId','accountBindingId','actorId','bindingGeneration','activityGeneration','visibilityScope']);
export const SOCIAL_CHANNELS=Object.freeze(['app-private','app-group','qq-private','qq-group','bilibili']);
export const SOCIAL_STAGES=Object.freeze(['received','material-read','understood','presented','sent','failed','cancelled','unknown']);
export function socialError(message,code='BUDDY_SOCIAL_DENIED'){return Object.assign(Error(message),{code});}
export function socialId(value,name){if(typeof value!=='string'||!value||value.length>300||value.includes('\0'))throw socialError('Invalid '+name,'BUDDY_REQUEST_INVALID');return value;}
export function validateSocialScope(scope){
 for(const key of ['characterId','personaId','lifeId','operationId','sessionId','conversationId','accountBindingId','actorId'])socialId(scope[key],key);
 if(!SOCIAL_CHANNELS.includes(scope.channel)||scope.contextKind!=='social')throw socialError('Invalid social channel or context');
 for(const key of ['bindingGeneration','activityGeneration'])if(!Number.isSafeInteger(scope[key])||scope[key]<1)throw socialError('Invalid social generation');
 if(scope.taskId||scope.workspace||scope.approvedPlanRevision)throw socialError('Social context cannot claim a work task, workspace or approval');
 if(scope.permissionScope?.some(cap=>!SOCIAL_CAPABILITIES.includes(cap)))throw socialError('Social capability cannot grant work access','BUDDY_CAPABILITY_DENIED');
 return scope;
}
