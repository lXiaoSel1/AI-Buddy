// Archive and startup failures can never trigger deletion of the old build.
export async function releaseFlow(steps) {
  const result={ok:false,switched:false,rolledBack:false};
  await steps.archivePrevious();
  try {
    result.stopping=true;
    await steps.stopCurrent();
    result.switched=true;
    await steps.switchBuild();
    await steps.startBuild();
    await steps.checkStartup();
    result.ok=true;
  } catch(error) {
    if(result.stopping){await steps.rollback();result.rolledBack=true;}
    error.releaseState=result;
    throw error;
  }
  try{await steps.cleanupPrevious();}catch(error){result.cleanupWarning=error.message;}
  return result;
}
