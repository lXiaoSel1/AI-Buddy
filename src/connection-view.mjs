export function connectionView(service){
 const view=service.view();
 return {...view,profiles:view.profiles.map(profile=>{
  let locked=false;try{service.unlocked(profile.id);}catch{locked=true;}
  return {...profile,locked};
 })};
}
