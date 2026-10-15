import {dirname,resolve} from 'node:path';

// The active pointer lives in local/, while a candidate collection may live in
// a nested production directory. Keep its source references valid after moving.
export function relocateSequenceCollection(collection,sourceFile){
 const next=structuredClone(collection),base=dirname(resolve(sourceFile));
 const resolveGroup=group=>{if(Array.isArray(group.manifests))group.manifests=group.manifests.map(file=>resolve(base,file));};
 resolveGroup(next);for(const group of Object.values(next.characters??{}))resolveGroup(group);
 return next;
}
