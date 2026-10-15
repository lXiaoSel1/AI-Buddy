"""Maintainer-only staged publication. Credentials are used only for GitHub API calls."""
from pathlib import Path
import argparse,subprocess,json,urllib.request,urllib.parse,urllib.error,hashlib,http.client,time,concurrent.futures
p=argparse.ArgumentParser();p.add_argument('action',choices=['pr','merge','upload','prerelease','promote','verification']);p.add_argument('--work',required=True);a=p.parse_args()
repo=Path(__file__).resolve().parents[1];work=Path(a.work).resolve();base='/repos/lXiaoSel1/AI-Buddy'
def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))
def save(name,value):(work/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
def sha(path):
 with path.open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
credential=subprocess.run(['git','-c','credential.interactive=never','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,cwd=repo,check=True)
values=dict(line.split('=',1)for line in credential.stdout.splitlines()if '=' in line)
headers={'Authorization':'Bearer '+values['password'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'AI-Buddy-release'}
def api(method,path,body=None):
 req=urllib.request.Request('https://api.github.com'+path,data=json.dumps(body).encode()if body is not None else None,headers={**headers,'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(req,timeout=60)as res:return json.load(res)
assert api('GET','/user')['login'].lower()=='lxiaosel1'
assert api('GET',base)['private']is False,'Do not change repository visibility'
assert read(work/'source-privacy.json')['ok']
assert git('status','--porcelain')=='','Commit source before publication'
if a.action=='pr':
 branch=git('branch','--show-current');assert branch=='codex/installer-1.8.0'
 matches=api('GET',base+'/pulls?state=open&head='+urllib.parse.quote('lXiaoSel1:'+branch))
 pr=matches[0]if matches else api('POST',base+'/pulls',dict(title='AI Buddy 1.8.0: online installer and optional character resources',head=branch,base='main',body=(work/'pull-request.md').read_text(encoding='utf-8')))
 assert pr['head']['sha']==git('rev-parse','HEAD');result=dict(ok=True,number=pr['number'],url=pr['html_url'],head=pr['head']['sha']);save('pull-request.json',result);print(json.dumps(result));raise SystemExit
if a.action=='merge':
 pr=read(work/'pull-request.json');current=api('GET',base+f'/pulls/{pr["number"]}');assert current['head']['sha']==pr['head']
 result=api('PUT',base+f'/pulls/{pr["number"]}/merge',dict(merge_method='merge',sha=pr['head'],commit_title='Merge AI Buddy 1.8.0 installer release'));assert result['merged'];save('pull-request-merged.json',dict(ok=True,**result));print(json.dumps(result));raise SystemExit
assert read(work/'local-release-gates.json')['ok'];assert git('branch','--show-current')=='main'
commit=git('rev-parse','HEAD');assert api('GET',base+'/git/ref/heads/main')['object']['sha']==commit
releases=api('GET',base+'/releases?per_page=100');release=next((r for r in releases if r['tag_name']=='v1.8.0'),None)
if release is None:
 assert a.action=='upload'
 try:tag=api('GET',base+'/git/ref/tags/v1.8.0')
 except urllib.error.HTTPError as e:
  if e.code!=404:raise
 else:assert tag['object']['sha']==commit,'Existing tag must not be replaced'
 release=api('POST',base+'/releases',dict(tag_name='v1.8.0',target_commitish=commit,name='AI 酱 / AI Buddy 1.8.0 · Online installer / 30fps / 60fps',body=(work/'release-notes.md').read_text(encoding='utf-8'),draft=True,prerelease=True))
assert release['target_commitish']==commit,'Release belongs to another source commit'
save('github-release-state.json',dict(id=release['id'],url=release['html_url'],draft=release['draft'],prerelease=release['prerelease'],commit=commit))
assets=api('GET',base+f'/releases/{release["id"]}/assets?per_page=100')
def upload(entry):
 path=Path(entry['path']);assert path.stat().st_size==entry['bytes']and sha(path)==entry['sha256'];assert entry['bytes']<=1024**3
 asset=next((x for x in assets if x['name']==entry['name']),None)
 if asset:assert asset['state']=='uploaded'and asset['size']==entry['bytes']and asset.get('digest')=='sha256:'+entry['sha256'],'Existing asset differs; no replacement'
 else:
  conn=http.client.HTTPSConnection('uploads.github.com',timeout=300);conn.putrequest('POST',base+f'/releases/{release["id"]}/assets?name='+urllib.parse.quote(entry['name']))
  for k,v in {**headers,'Content-Type':'application/octet-stream','Content-Length':str(entry['bytes'])}.items():conn.putheader(k,v)
  conn.endheaders();sent=0;last=time.monotonic()
  with path.open('rb')as f:
   while chunk:=f.read(1024*1024):
    conn.send(chunk);sent+=len(chunk)
    if time.monotonic()-last>20:print(json.dumps(dict(file=path.name,sent=sent,total=entry['bytes'])),flush=True);last=time.monotonic()
  response=conn.getresponse();raw=response.read();conn.close();assert response.status==201,'Upload HTTP '+str(response.status);asset=json.loads(raw)
  assert asset['size']==entry['bytes']and asset.get('digest')=='sha256:'+entry['sha256']
 print('VERIFIED '+path.name,flush=True);return {k:asset[k]for k in ['id','name','size','digest','browser_download_url']}
if a.action=='upload':
 assert release['draft'];spec=read(work/'release-assets.json');assert spec['ok']
 with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:verified=list(pool.map(upload,spec['files']))
 save('github-upload.json',dict(ok=True,releaseId=release['id'],assets=verified));print('Draft upload complete',flush=True)
elif a.action=='prerelease':
 assert read(work/'github-upload.json')['ok'];release=api('PATCH',base+f'/releases/{release["id"]}',dict(draft=False,prerelease=True,make_latest='false'))
 save('github-prerelease.json',dict(ok=True,url=release['html_url'],id=release['id']));print(release['html_url'])
elif a.action=='verification':
 report=read(work/'anonymous-validation.json');assert report['ok']
 path=work/'release-assets/VERIFICATION-1.8.0.json';assert path.exists();upload(dict(path=str(path),name=path.name,bytes=path.stat().st_size,sha256=sha(path)))
elif a.action=='promote':
 assert read(work/'anonymous-validation.json')['ok'];assert not release['draft']
 release=api('PATCH',base+f'/releases/{release["id"]}',dict(prerelease=False,make_latest='true'))
 latest=api('GET',base+'/releases/latest');assert latest['tag_name']=='v1.8.0'
 save('github-release.json',dict(ok=True,url=release['html_url'],commit=commit,prerelease=False,latest=True,assets=assets));print(release['html_url'])
