import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {pythonFixture,save,read} from './support/public-distribution-fixtures.mjs';

const script=fileURLToPath(new URL('../scripts/package-installer-202.py',import.meta.url));
function packagePortable(f){
 const out=path.join(f.dir,'release'),work=path.join(f.dir,'offline'),installer=path.join(f.dir,'manager.exe');save(installer,'manager bytes hashed from the copied file');
 const driver=`import importlib.util,sys,json,contextlib,io,subprocess
from pathlib import Path
from unittest.mock import patch
script=Path(sys.argv[1]);sys.path.insert(0,str(script.parent))
spec=importlib.util.spec_from_file_location('packaging',script);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
candidate,out,work,installer=map(Path,sys.argv[2:6]);bound=m.group_trees
m.group_trees=lambda value:bound(value,inventory_path=Path(sys.argv[6]),inventory_sha256=sys.argv[7])
with contextlib.redirect_stdout(io.StringIO()): m.package(candidate,out)
def inspect(command,**kwargs):
 receipt=Path(next(v[10:] for v in command if v.startswith('--receipt=')))
 receipt.write_text(json.dumps(dict(ok=True,version=m.VERSION,manifestSha256=m.sha(out/('install-manifest-'+m.VERSION+'.json')),appUpdateProtocol=1,appBootstrapProtocol=1)),encoding='utf-8-sig')
 return subprocess.CompletedProcess(command,0,'','')
with patch('subprocess.run',side_effect=inspect),contextlib.redirect_stdout(io.StringIO()): result=m.portable(candidate,out,installer,work)
print(json.dumps(dict(ok=result['ok'],managerSha256=m.sha(installer))))`;
 const run=spawnSync(process.platform==='win32'?'py':'python3',[...process.platform==='win32'?['-3','-B']:['-B'],'-c',driver,script,f.candidate,out,work,installer,f.inventoryPath,f.inventorySha256],{encoding:'utf8',windowsHide:true});
 if(run.error)throw run.error;assert.equal(run.status,0,run.stderr);return{work,...JSON.parse(run.stdout)};
}
test('both portable editions register the inspected manager and its actual copied bytes',t=>{
 const result=packagePortable(pythonFixture(t));
 for(const edition of['30fps','60fps']){
  const root=path.join(result.work,edition,'AI-Buddy'),record=read(path.join(root,'local/portable-defaults.json')).installation;
  assert.equal(record.managerProtocol,1);assert.equal(record.managerSha256,result.managerSha256);
  assert(fs.existsSync(path.join(root,record.manager)));
 }
});
