export const AUTO_LIVE_LIMITS=Object.freeze({completed:200,retiredRequests:200,history:20,authorizations:200});
export function compactAutoGroups(state,archive){
 const rows=[],removals=[];
 const trim=(record,limit,namespace)=>{const entries=Object.entries(record??{});for(const [id,value] of entries.slice(0,Math.max(0,entries.length-limit))){rows.push({namespace,id,value});removals.push(()=>delete record[id]);}};
 for(const [groupId,group] of Object.entries(state.groups??{})){
  const autos=[group.auto,...(group.autoEvidenceVersion===1?[]:group.autoHistory??[])].filter(Boolean);
  for(const auto of autos){trim(auto.completed,AUTO_LIVE_LIMITS.completed,'auto-completed:'+auto.id);trim(auto.retiredRequests,AUTO_LIVE_LIMITS.retiredRequests,'auto-retired:'+auto.id);}
  trim(group.autoAuthorizations,AUTO_LIVE_LIMITS.authorizations,'auto-authorizations:'+groupId);
  const old=(group.autoHistory??[]).slice(0,-AUTO_LIVE_LIMITS.history);
  for(const value of old)rows.push({namespace:'auto-history:'+groupId,id:value.id,value});
  removals.push(()=>{group.autoEvidenceVersion=1;});
  if(old.length)removals.push(()=>{group.autoHistory=group.autoHistory.slice(-AUTO_LIVE_LIMITS.history);});
 }
 if(rows.length)archive.putMany(rows);for(const remove of removals)remove();
}
