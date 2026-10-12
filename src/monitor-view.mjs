// Historical rows remain in the query service. Renderer status updates are small.
export function monitorView(snapshot,kind='panel'){
 if(kind==='pet')return {indexing:snapshot.indexing,todayUsage:snapshot.todayUsage,sessions:(snapshot.sessions||[]).filter(s=>['running','waiting'].includes(s.displayStatus)).map(s=>({displayStatus:s.displayStatus}))};
 return {usageRevision:snapshot.usageRevision,indexing:snapshot.indexing,indexPhase:snapshot.indexPhase,progress:snapshot.progress,today:snapshot.today,missingRequests:snapshot.missingRequests,errors:snapshot.errors};
}
