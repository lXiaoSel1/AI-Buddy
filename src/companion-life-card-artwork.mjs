import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');

export function locateLifeCardArtwork(card){
 const avatar=card?.avatar;
 if(typeof avatar!=='string'||avatar.length<1_000_000||!/^data:image\//i.test(avatar))return null;
 return {characterId:card.id,cardRevision:card.revision,length:avatar.length,sha256:digest(avatar)};
}

export function readLifeCardArtwork(state,locator,{verify=false}={}){
 const card=state.cards?.[locator.characterId],avatar=card?.avatar;
 if(card?.id!==locator.characterId||card.revision!==locator.cardRevision||
   typeof avatar!=='string'||avatar.length!==locator.length||verify&&digest(avatar)!==locator.sha256)
  throw Object.assign(Error('操作失败。'),{code:'LIFE_ARCHIVE_CARD_ARTWORK_STALE'});
 return avatar;
}


export function expandLifeArchiveArtwork(plan,artwork,state,options){
 const slot=plan.recordStages.get(JSON.stringify(['root.lifeArchives','']));
 for(const {archiveId,locator} of artwork){
  const row=slot?.rows.get(archiveId)?.value;
  if(row?.id!==archiveId||row.characterId!==locator.characterId||Object.hasOwn(row,'avatar'))
   throw Error('Operation failed to restore the archive artwork');
  row.avatar=readLifeCardArtwork(state,locator,options);
 }
}
