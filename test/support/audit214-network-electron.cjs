const {app}=require('electron');
const {writeFile}=require('node:fs/promises');
const {join}=require('node:path');
app.commandLine.appendSwitch('disable-gpu');
// Keep Electron's entry-module load free of top-level app.whenReady() awaits.
app.whenReady().then(()=>import('./audit214-network-electron.mjs')).catch(async error=>{
  await writeFile(join(process.env.AUDIT214_SERVICE_RUN,'result.json'),JSON.stringify({electron:process.versions.electron,checks:[],fatal:error.stack??String(error)},null,2));app.exit(2);
});
