import {EMOTIONS} from './emotions.mjs';
export class PetTouchExpressions{
  constructor({random=Math.random}={}){this.random=random;this.bags=new Map();this.last=new Map();}
  next(characterId){
    let bag=this.bags.get(characterId);
    if(!bag?.length){
      bag=Object.values(EMOTIONS).map(v=>v.actionId);
      for(let i=bag.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
      if(bag.at(-1)===this.last.get(characterId))[bag[0],bag[bag.length-1]]=[bag.at(-1),bag[0]];
      this.bags.set(characterId,bag);
    }
    const id=bag.pop();this.last.set(characterId,id);return id;
  }
}
