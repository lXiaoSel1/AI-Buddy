/** R95 r1 transport contract. Types describe references; they confer no authority. */
export type SocialChannel='app-private'|'app-group'|'qq-private'|'qq-group'|'bilibili';
export type SocialStage='received'|'material-read'|'understood'|'presented'|'sent'|'failed'|'cancelled'|'unknown';
export type TerminalActivityStatus='completed'|'failed'|'cancelled'|'unknown';
export type SocialMethod='social.context.read'|'models.request'|'activity.lease'|'activity.finish'|'experience.append'|'proactive.offer'|'search.native'|'owner.work.propose'|'owner.work.approve';
export type SocialCapability=SocialMethod|'tools.list'|'tools.invoke'|'notifications.publish'|'ui.registerPage'|'lifecycle.register';
export interface SocialScope {
 readonly contextKind:'social'; readonly characterId:string; readonly personaId:string;
 readonly lifeId:string; readonly operationId:string; readonly sessionId:string;
 readonly channel:SocialChannel; readonly conversationId:string; readonly accountBindingId:string;
 readonly actorId:string; readonly bindingGeneration:number; readonly activityGeneration:number;
 readonly visibilityScope:string; readonly taskId:null;
 readonly contextRevision:number|string; readonly permissionScope:readonly SocialCapability[];
 readonly connectionRefs:readonly string[]; readonly planState:'planning';
 readonly readOnlyToolNames:readonly [];
}
export interface IssuedSocialContext {
 readonly version:'buddy-bridge-v1'; readonly contextToken:string; readonly pluginId:string;
 readonly context:SocialScope; readonly issuedAt:number; readonly expiresAt:number|null;
}
export interface SocialCallOptions {readonly signal?:AbortSignal}
export interface ContextRequest {query?:string}
export interface LeaseRequest {activityId:string}
export interface LeaseReceipt {leaseId:string;scope:Readonly<SocialScope>;duplicate?:true}
export interface FinishRequest {leaseId:string;status:TerminalActivityStatus}
export interface FinishReceipt {finished:true;duplicate?:true}
export interface AppendRequest {eventRef:string}
export interface AppendReceipt {recorded:true;eventId:string;duplicate?:true}
export interface OfferRequest {eventRef:string;kind?:'share'|'selftalk';text?:string;expiresAt?:number|null}
/** A candidate receipt does not claim delivery, understanding, user attention or sharing. */
export interface OfferReceipt {duplicate?:boolean;candidate?:Readonly<Record<string,unknown>>;offered?:boolean}
export interface ModelMessage {role:'user'|'assistant';content:string}
export interface ModelRequest {
 connectionRef:string;messages:ModelMessage[];system?:string;background?:boolean;
 /** Supply explicitly. Host may resolve one exact-scope active lease; never guess another scope. */
 leaseId?:string;
}
export interface ProviderSearchSource {url:string;title?:string;provenance?:'provider-tool';[key:string]:unknown}
export interface NativeSearchReceipt {status?:string;sources:ProviderSearchSource[];events?:Readonly<Record<string,unknown>>[];reason?:string}
export interface ModelReceipt {
 connection:{id:string;kind?:string;model?:string};parts:Readonly<Record<string,unknown>>[];
 text:string;usageAccounting:'core-model-router';nativeSearch?:NativeSearchReceipt;
}
export interface SearchRequest {query:string;leaseId?:string}
export interface SearchReceipt {text:string;sources:ProviderSearchSource[];nativeSearch?:NativeSearchReceipt}
export interface OwnerProposalRequest {eventRef:string;projectId:string}
export interface OwnerChallengeRequest {eventRef:string;taskId:string}
export interface OwnerApprovalRequest {eventRef:string;challengeId:string}
export interface OwnerChallengeReceipt {challengeId:string;taskId:string;planVersion:number|string;planHash:string;workspace:string;expiresAt:number}
export interface SocialPayloads {
 'social.context.read':ContextRequest;'models.request':ModelRequest;'activity.lease':LeaseRequest;
 'activity.finish':FinishRequest;'experience.append':AppendRequest;'proactive.offer':OfferRequest;
 'search.native':SearchRequest;'owner.work.propose':OwnerProposalRequest;
 'owner.work.approve':OwnerChallengeRequest|OwnerApprovalRequest;
}
export interface SocialResults {
 'social.context.read':Readonly<Record<string,unknown>>;'models.request':ModelReceipt;
 'activity.lease':LeaseReceipt;'activity.finish':FinishReceipt;'experience.append':AppendReceipt;
 'proactive.offer':OfferReceipt;'search.native':SearchReceipt;
 'owner.work.propose':Readonly<Record<string,unknown>>;'owner.work.approve':OwnerChallengeReceipt|Readonly<Record<string,unknown>>;
}
export interface SocialInvokeRequest<M extends SocialMethod=SocialMethod> {pluginId:string;contextToken:string;method:M;payload:SocialPayloads[M]}
export interface SocialInvoke {<M extends SocialMethod>(request:SocialInvokeRequest<M>,options?:SocialCallOptions):Promise<SocialResults[M]>}
export interface SocialClient {
 readonly version:'social-contract-v1';
 calls<M extends SocialMethod>(method:M,payload:SocialPayloads[M],options?:SocialCallOptions):Promise<SocialResults[M]>;
 context(payload?:ContextRequest,options?:SocialCallOptions):Promise<SocialResults['social.context.read']>;
 lease(payload:LeaseRequest,options?:SocialCallOptions):Promise<LeaseReceipt>;
 finish(payload:FinishRequest,options?:SocialCallOptions):Promise<FinishReceipt>;
 append(payload:AppendRequest,options?:SocialCallOptions):Promise<AppendReceipt>;
 offer(payload:OfferRequest,options?:SocialCallOptions):Promise<OfferReceipt>;
 model(payload:ModelRequest,options?:SocialCallOptions):Promise<ModelReceipt>;
 search(payload:SearchRequest,options?:SocialCallOptions):Promise<SearchReceipt>;
 readonly owner:{propose(payload:OwnerProposalRequest,options?:SocialCallOptions):Promise<Readonly<Record<string,unknown>>>;challenge(payload:OwnerChallengeRequest,options?:SocialCallOptions):Promise<OwnerChallengeReceipt>;approve(payload:OwnerApprovalRequest,options?:SocialCallOptions):Promise<Readonly<Record<string,unknown>>>};
}
export declare function createSocialClient(options:{pluginId:string;contextToken:string;invoke:SocialInvoke}):SocialClient;

/** HOST ONLY: not exported through the plugin client, renderer, JSON RPC or grants. */
export interface CoreNativeEvent {
 characterId:string;personaId:string;sessionId:string;conversationId:string;actorId:string;
 nativeMessageId:string;text:string;occurredAt:number;stage:SocialStage;status:string;
 visibilityScope:string;sourceKind?:string;activityGeneration?:number;forwarded?:boolean;quoted?:boolean;
}
/** A accepts neither this callback nor its result from plugin-supplied JSON. */
export interface CoreTransportRegistration {
 pluginId:string;channel:SocialChannel;accountBindingId:string;generation:number;
 verify(raw:unknown):Promise<CoreNativeEvent|null>|CoreNativeEvent|null;
}
export interface CoreObservedEvidence {
 pluginId:string;eventRef:string;sourceKind:string;nativeEvidenceId:string;stage:SocialStage;
 status:string;text:string;evidenceRefs:unknown[];presentationState?:'not-presented'|'presented';
 deliveryState?:'not-sent'|'sent'|'delivered'|'unknown'|'failed';
}
