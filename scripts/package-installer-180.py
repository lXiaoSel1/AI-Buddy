"""Independent ZIP packages; no image or video encoding. Python is a maintainer dependency only."""
import argparse, hashlib, json, pathlib, zipfile
P=argparse.ArgumentParser();P.add_argument('--candidate',required=True);P.add_argument('--output',required=True);P.add_argument('--repo',required=True);a=P.parse_args()
candidate=pathlib.Path(a.candidate).resolve();out=pathlib.Path(a.output).resolve();repo=pathlib.Path(a.repo).resolve();out.mkdir(parents=True,exist_ok=True)
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def scan(base):return {p.relative_to(base).as_posix():dict(path=p.relative_to(base).as_posix(),bytes=p.stat().st_size,sha256=sha(p)) for p in sorted(base.rglob('*')) if p.is_file()}
trees={e:scan(candidate/e/'build') for e in ['30fps','60fps']};groups={};owners={}
for e in trees:
 index=json.loads((candidate/e/'build/assets/install-resource-index.json').read_text(encoding='utf-8'))
 for char,files in index['characters'].items():
  for f in files:owners[f['path']]=char
def add(group,mount,path,meta,base,char=None,edition=None):
 g=groups.setdefault(group,dict(mount=mount,files=[],base=base,characterId=char,edition=edition));g['files'].append(meta)
for path,meta in trees['30fps'].items():
 other=trees['60fps'].get(path);same=other and other['sha256']==meta['sha256'];char=owners.get(path)
 if char and same:add('character-'+char,'build',path,meta,candidate/'30fps/build',char)
 elif same and path.startswith('assets/') and path!='assets/install-resource-index.json':add('shared','build',path,meta,candidate/'30fps/build')
 else:
  for edition in trees:
   if path not in trees[edition]:raise RuntimeError('Edition file is missing: '+path)
   group=('motion-'+char+'-' if char else 'app-')+edition
   add(group,'build',path,trees[edition][path],candidate/edition/'build',char,edition)
assert set(trees['30fps'])==set(trees['60fps'])
for mount in ['root','runtime']:
 for path,meta in scan(candidate/mount).items():add(mount,mount,path,meta,candidate/mount)
prior=json.loads((out/'install-manifest-1.8.0.json').read_text(encoding='utf-8')) if (out/'install-manifest-1.8.0.json').exists() else {}
priorPackages={p['id']:p for p in prior.get('packages',[])}
packages=[];ids={};limit=1024**3
for group,g in sorted(groups.items()):
 chunks=[[]];size=0
 for f in g['files']:
  if f['bytes']>950*1024**2:raise RuntimeError('Single file exceeds safe independent ZIP size: '+f['path'])
  if size+f['bytes']>950*1024**2:chunks.append([]);size=0
  chunks[-1].append(f);size+=f['bytes']
 ids[group]=[]
 for i,files in enumerate(chunks):
  id=group+(('-'+str(i+1)) if len(chunks)>1 else '');asset='AI-Buddy-1.8.0-'+id+'.zip';path=out/asset
  previous=priorPackages.get(id)
  if previous and previous['files']==files and path.exists() and path.stat().st_size==previous['bytes'] and sha(path)==previous['sha256']:
   packages.append(previous);ids[group].append(id);print('Verified reuse '+asset,flush=True);continue
  # Fixed timestamps make regeneration deterministic. Already compressed media is stored without recompression.
  with zipfile.ZipFile(path,'w',allowZip64=True) as z:
   for f in files:
    info=zipfile.ZipInfo(f['path'],(2026,10,14,0,0,0));info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_STORED if pathlib.Path(f['path']).suffix.lower() in ['.webm','.webp','.png','.jpg','.ico'] else zipfile.ZIP_DEFLATED
    with (g['base']/f['path']).open('rb') as src,z.open(info,'w',force_zip64=True) as dest:
     while chunk:=src.read(1024*1024):dest.write(chunk)
  if path.stat().st_size>limit:raise RuntimeError('Oversized ZIP '+asset)
  fileIndex=''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in files).encode()
  p=dict(id=id,kind=group.split('-')[0],mount=g['mount'],assetName=asset,bytes=path.stat().st_size,unpackedBytes=sum(f['bytes'] for f in files),sha256=sha(path),filesSha256=hashlib.sha256(fileIndex).hexdigest(),dependsOn=[],files=files)
  if g['characterId']:p['characterId']=g['characterId']
  if g['edition']:p['edition']=g['edition']
  packages.append(p);ids[group].append(id)
  print(asset,p['bytes'],flush=True)
names={'deepseek':'DeepSeek','claude':'Claude','grok':'Grok','seed':'Seed','kimi':'Kimi','qwen':'Qwen','minimax':'MiniMax','chatgpt':'GPT','gemini':'Gemini','glm':'GLM','hunyuan':'混元'}
characters=[]
for id,name in names.items():
 common=ids['character-'+id];assert len(common)==1
 characters.append(dict(id=id,name=name,commonPackageId=common[0],motions={e:ids['motion-'+id+'-'+e] for e in trees}))
editions=[]
for e in trees:
 app=ids['app-'+e];assert len(app)==1;editions.append(dict(id=e,label=e,appPackageId=app[0]))
manifest=dict(schemaVersion=1,appVersion='1.8.0',releaseTag='v1.8.0',repository='lXiaoSel1/AI-Buddy',platform='win32',arch='x64',minimumInstallerVersion='1.8.0',resourceContractVersion=1,defaultEdition='30fps',defaultCharacterId='deepseek',requiredPackageIds=ids['root']+ids['runtime']+ids['shared'],runtime=dict(executable='AI Buddy.exe',sha256=sha(candidate/'runtime/AI Buddy.exe')),editions=editions,characters=characters,packages=packages)
raw=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode();path=out/'install-manifest-1.8.0.json';path.write_bytes(raw);digest=hashlib.sha256(raw).hexdigest()
generated=repo/'installer/generated';generated.mkdir(parents=True,exist_ok=True);(generated/'install-manifest.json').write_bytes(raw)
(repo/'installer/BuildIdentity.g.cs').write_text('namespace AiBuddy.Setup; internal static class BuildIdentity { public const string ManifestSha256="'+digest+'"; }\n',encoding='utf-8')
# Reconstruct every selection's file index without extracting, then compare complete editions to candidates.
for edition in trees:
 selected=[p for p in packages if not p.get('edition') or p['edition']==edition]
 for mount in ['build','root','runtime']:
  reconstructed={}
  for p in selected:
   if p['mount']==mount:
    for f in p['files']:
     if f['path'] in reconstructed:raise RuntimeError('Implicit overwrite '+f['path'])
     reconstructed[f['path']]=f
  expected=trees[edition] if mount=='build' else scan(candidate/mount)
  assert reconstructed==expected,(edition,mount)
receipt=dict(ok=True,manifestSha256=digest,packages=len(packages),maxPackageBytes=max(p['bytes'] for p in packages),editions={e:dict(downloadBytes=sum(p['bytes'] for p in packages if not p.get('edition') or p['edition']==e),installedBytes=sum(p['unpackedBytes'] for p in packages if not p.get('edition') or p['edition']==e)) for e in trees})
(out/'packaging-result.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
