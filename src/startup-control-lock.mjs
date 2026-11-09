// The control pipe also serves as the startup/maintenance exclusion boundary.
// Do not begin business initialization until Node confirms that listen succeeded.
export function claimControlPipe(control,pipe){
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{control.removeListener('error',failed);control.removeListener('listening',claimed);};
  const failed=error=>{cleanup();reject(error);};
  const claimed=()=>{cleanup();resolve();};
  control.once('error',failed);control.once('listening',claimed);
  try{control.listen(pipe);}catch(error){failed(error);}
 });
}
