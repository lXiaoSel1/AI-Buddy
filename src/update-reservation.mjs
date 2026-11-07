export function updateError(code){return Object.assign(new Error(code),{code});}

export function createUpdateReservation({external=()=>[],now=Date.now,reservationMs=11*60_000}={}){
  const activities=new Map();
  let reservation=null,revision=0,last='';
  const active=()=>{
    if(reservation&&!reservation.committed&&reservation.expiresAt<=now())reservation=null;
    return !!reservation;
  };
  const status=()=>{
    const busyReasons=[...new Set([...activities.keys(),...external()])];
    const reasons=busyReasons.map(capability=>({capability}));
    const reserved=active();
    const stamp=JSON.stringify([busyReasons,reservation?.id,reservation?.committed]);
    if(stamp!==last){last=stamp;revision++;}
    return {busy:reasons.length>0,reasons,revision,reserved};
  };
  function enter(capability){
    if(active())throw updateError('APP_UPDATE_RESERVED');
    activities.set(capability,(activities.get(capability)??0)+1);
    let ended=false;
    return ()=>{
      if(ended)return;
      ended=true;
      const remaining=activities.get(capability)-1;
      if(remaining)activities.set(capability,remaining);else activities.delete(capability);
    };
  }
  function run(capability,task){
    const leave=enter(capability);
    try{
      const result=task();
      if(result&&typeof result.then==='function')return Promise.resolve(result).finally(leave);
      leave();return result;
    }catch(error){leave();throw error;}
  }
  function reserve(id){
    if(active()&&reservation.id!==id)return {ok:false,...status()};
    reservation??={id,expiresAt:now()+reservationMs,committed:false};
    return {ok:true,...status()};
  }
  function release(id){
    if(!active()||reservation.id!==id||reservation.committed)return false;
    reservation=null;return true;
  }
  function commit(id){
    const state=status();
    if(!reservation||reservation.id!==id||reservation.committed||state.busy)return {ok:false,...state};
    reservation.committed=true;
    return {ok:true,...status()};
  }
  function reopenAfterFailedShutdown(){reservation=null;}
  return {active,status,enter,run,reserve,release,commit,committed:()=>reservation?.committed===true,reopenAfterFailedShutdown};
}
