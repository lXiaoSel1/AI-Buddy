"""Create complete offline editions and <=1 GiB volumes without changing media."""
import argparse, hashlib, json, shutil, zipfile
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--work',required=True);a=p.parse_args()
work=Path(a.work).resolve();assets=work/'release-assets';candidate=work/'candidate'
manifestPath=assets/'install-manifest-1.8.0.json';manifest=json.loads(manifestPath.read_text(encoding='utf-8'))
def sha(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def save(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
digest=sha(manifestPath);installer=work/'installer-build/AI-Buddy-Setup-1.8.0-win-x64.exe'
assert installer.is_file()
shutil.copy2(installer,assets/installer.name)
receipts=[]
for edition in ['30fps','60fps']:
 tree=work/'portable'/edition/'AI-Buddy';tree.mkdir(parents=True,exist_ok=True)
 build='builds/v1.8.0-'+edition;runtime='runtime/AI-Buddy-v1.8.0';manager='maintenance/1.8.0/AI Buddy Setup.exe'
 for source,dest in [(candidate/'root',tree),(candidate/edition/'build',tree/build),(candidate/'runtime',tree/runtime)]:shutil.copytree(source,dest,dirs_exist_ok=True)
 (tree/manager).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(installer,tree/manager)
 selected=[x for x in manifest['packages'] if not x.get('edition') or x['edition']==edition]
 record=dict(schemaVersion=1,version='1.8.0',manifestSha256=digest,edition=edition,characters=[c['id'] for c in manifest['characters']],initialCharacter='deepseek',build=build,runtime=runtime,manager=manager,dataPath=None,pipe=None,installedAt='2026-10-15T00:00:00Z',packageHashes={x['id']:x['sha256'] for x in selected})
 save(tree/'local/installation.json',record)
 save(tree/'local/current-build.json',dict(version='1.8.0',appVersion='1.8.0',path=build,runtime=dict(path=runtime,**manifest['runtime']),animationProfile=edition))
 dest=tree/'local/install-manifests'/f'{digest}.json';dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(manifestPath,dest)
 for package in selected:
  base=tree if package['mount']=='root' else tree/(build if package['mount']=='build' else runtime)
  for f in package['files']:assert (base/f['path']).stat().st_size==f['bytes'] and sha(base/f['path'])==f['sha256'],f['path']
 index=[dict(path=f.relative_to(tree).as_posix(),bytes=f.stat().st_size,sha256=sha(f)) for f in sorted(tree.rglob('*')) if f.is_file()]
 assert not any('data-v003/' in f['path'] for f in index)
 archive=work/f'AI-Buddy-1.8.0-Windows-x64-{edition}.zip'
 with zipfile.ZipFile(archive,'w',allowZip64=True,compresslevel=1) as z:
  for f in index:
   info=zipfile.ZipInfo('AI-Buddy/'+f['path'],(2026,10,15,0,0,0));info.compress_type=zipfile.ZIP_STORED if Path(f['path']).suffix.lower() in ['.webm','.webp','.png','.jpg','.jpeg','.zip'] else zipfile.ZIP_DEFLATED
   with (tree/f['path']).open('rb') as src,z.open(info,'w',force_zip64=True) as target:shutil.copyfileobj(src,target,1024*1024)
 parts=[]
 with archive.open('rb') as stream:
  number=1
  while True:
   start=stream.tell();part=assets/(archive.name+f'.part{number:02}');hasher=hashlib.sha256();length=0
   with part.open('wb') as output:
    while length<1024**3:
     chunk=stream.read(min(4*1024**2,1024**3-length))
     if not chunk:break
     output.write(chunk);hasher.update(chunk);length+=len(chunk)
   if not length:part.unlink();break
   parts.append(dict(file=part.name,bytes=length,sha256=hasher.hexdigest()));number+=1
 receipt=dict(file=archive.name,bytes=archive.stat().st_size,sha256=sha(archive),parts=parts)
 save(assets/(archive.name+'.parts.json'),receipt)
 save(work/f'portable-{edition}-files.json',dict(ok=True,root=str(tree),files=index,archive=receipt))
 receipts.append(dict(edition=edition,installedBytes=sum(x['bytes'] for x in index),**receipt));print(json.dumps(receipts[-1]),flush=True)
save(work/'offline-packages.json',dict(ok=True,editions=receipts))
