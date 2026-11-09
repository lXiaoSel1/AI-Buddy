import React from 'react';
import {t} from './i18n.mjs';
const actions=new Set(['sources-preview','sources-add','sources-refresh','refresh','search','details','plan','install','install-update','community-load-catalog','community-refresh','community-search','community-details','community-author','community-find-review','community-check-review','community-check-updates','community-plan-update','community-install-update','dsh-component-plan','dsh-component-install','dsh-plan','dsh-install','bili-component-prepare']);
const eligible=request=>request&&actions.has(request.action)&&request.official!==true;
export const mirrorRetryError=error=>(error?.code??error?.error?.code)==='NETWORK_MIRROR_MISMATCH'&&(error?.retryOfficial??error?.details?.retryOfficial)!==false;
// Each error owns its original request; background polls cannot replace a pending retry.
export async function invokeWithOfficialRetry(invoke,request){const original=eligible(request)?structuredClone(request):null;try{return await invoke(request);}catch(error){if(original&&mirrorRetryError(error)&&error&&typeof error==='object')error.officialRetryRequest=original;throw error;}}
export function officialRetryPin(error){return eligible(error?.officialRetryRequest)&&mirrorRetryError(error)?{request:structuredClone(error.officialRetryRequest),host:error.host??error.details?.host??'',code:error.code}:null;}
export function officialRetryRequest(pin){if(!eligible(pin?.request))throw Object.assign(Error('No pinned download request'),{code:'OFFICIAL_RETRY_UNAVAILABLE'});return {...structuredClone(pin.request),official:true};}
export function OfficialRetryButton({retry,busy=false,onRetry}){return retry?React.createElement('button',{type:'button',className:'ui-btn sm','data-official-address-retry':true,disabled:busy,onClick:onRetry},t('改用官方地址重试')):null;}
