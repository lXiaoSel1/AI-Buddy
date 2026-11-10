const {app}=require('electron');
const {writeFile}=require('node:fs/promises');
const {join}=require('node:path');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(()=>import('./round2-network-electron.mjs')).catch(async error=>{
  await writeFile(join(process.env.ROUND2_NETWORK_RUN,'result.json'),JSON.stringify({electron:process.versions.electron,checks:[],fatal:error.stack??String(error)},null,2));app.exit(2);
});
