"""Deterministic independent ZIPs for the accepted 1.9.0 trees; never encode media."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import zipfile

VERSION = '1.9.0'
LIMIT = 1024 ** 3
CHUNK_LIMIT = 950 * 1024 ** 2
NAMES = {'deepseek': 'DeepSeek', 'claude': 'Claude', 'grok': 'Grok', 'seed': 'Seed', 'kimi': 'Kimi', 'qwen': 'Qwen', 'minimax': 'MiniMax', 'chatgpt': 'GPT', 'gemini': 'Gemini', 'glm': 'GLM', 'hunyuan': '混元'}
MEDIA = {'.webm', '.webp', '.png', '.jpg', '.jpeg', '.ico', '.zip'}
APPROVED_MEDIA = 'bb3b110d6f165eb449dbf797eef549c98f7d521cbf4d7766a746f7ac28122e58'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def scan(base):
    result = {}
    folded = set()
    for path in sorted(base.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlink in distribution: ' + str(path))
        if not path.is_file():
            continue
        name = path.relative_to(base).as_posix()
        if name.casefold() in folded:
            raise ValueError('Case-insensitive duplicate: ' + name)
        folded.add(name.casefold())
        result[name] = dict(path=name, bytes=path.stat().st_size, sha256=sha(path))
    return result


def validate_path(name):
    p = PurePosixPath(name)
    if '\\' in name or ':' in name or p.is_absolute() or any(x in ('', '.', '..') for x in name.split('/')):
        raise ValueError('Unsafe archive path: ' + name)


def index_hash(files):
    return hashlib.sha256(''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in files).encode()).hexdigest()


def group_trees(candidate):
    proof = json.loads((candidate / 'media-proof.json').read_text(encoding='utf-8'))
    approval = proof.get('approvedMedia', {})
    receipt_path = Path(approval.get('receiptPath', ''))
    approval_path = Path(approval.get('approvalPath', ''))
    if proof.get('ok') is not True or proof.get('version') != VERSION or proof.get('reencoded') != 0 or approval.get('sha256') != APPROVED_MEDIA or sha(receipt_path) != APPROVED_MEDIA or sha(approval_path) != approval.get('approvalSha256'):
        raise ValueError('Candidate lacks the fixed approved media proof')
    media_receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    trees = {edition: scan(candidate / edition / 'build') for edition in ('30fps', '60fps')}
    if set(trees['30fps']) != set(trees['60fps']):
        raise ValueError('Edition file sets differ')
    owners = {}
    for edition in trees:
        base = candidate / edition / 'build'
        package = json.loads((base / 'package.json').read_text(encoding='utf-8'))
        index = json.loads((base / 'assets/install-resource-index.json').read_text(encoding='utf-8'))
        if package['version'] != VERSION or package['animationProfile'] != edition or index['appVersion'] != VERSION:
            raise ValueError('Candidate version/profile mismatch')
        accepted = next(e for e in media_receipt['editions'] if str(e['fps']) + 'fps' == edition)['fileInventory']
        actual_assets = {p: f for p, f in trees[edition].items() if p.startswith('assets/') and p != 'assets/install-resource-index.json'}
        approved_assets = {p: dict(path=p, **f) for p, f in accepted.items() if p.startswith('assets/') and p != 'assets/install-resource-index.json'}
        if actual_assets != approved_assets:
            raise ValueError('Candidate media differs from the approved file tree')
        indexed = [f for files in [index['shared'], *index['characters'].values()] for f in files]
        if len(indexed) != len(actual_assets) or {f['path']: f for f in indexed} != actual_assets or set(index['characters']) != set(NAMES):
            raise ValueError('Resource index does not exactly cover all eleven characters and shared files')
        edition_proof = next(p for p in proof['proof'] if p['edition'] == edition)
        if sha(base / 'assets/install-resource-index.json') != edition_proof['resourceIndexSha256'] or {f['path']: f for f in edition_proof['codeFiles']} != {p: f for p, f in trees[edition].items() if not p.startswith('assets/')}:
            raise ValueError('Candidate code or resource index changed after distribution assembly')
        for character, files in index['characters'].items():
            if sum(f['path'].endswith('.webm') for f in files) != 24:
                raise ValueError('Character needs 24 action videos: ' + character)
            for f in files:
                if trees[edition].get(f['path']) != f:
                    raise ValueError('Resource index mismatch: ' + f['path'])
                if f['path'] in owners and owners[f['path']] != character:
                    raise ValueError('Resource owner changed between editions')
                owners[f['path']] = character
    groups = {}

    def add(group, mount, meta, base, character=None, edition=None):
        value = groups.setdefault(group, dict(mount=mount, files=[], base=base, characterId=character, edition=edition))
        value['files'].append(meta)

    for name, meta in trees['30fps'].items():
        same = trees['60fps'][name]['sha256'] == meta['sha256']
        character = owners.get(name)
        if character and same:
            add('character-' + character, 'build', meta, candidate / '30fps/build', character)
        elif same and name.startswith('assets/') and name != 'assets/install-resource-index.json':
            add('shared', 'build', meta, candidate / '30fps/build')
        else:
            for edition in trees:
                add(('motion-' + character + '-' if character else 'app-') + edition, 'build', trees[edition][name], candidate / edition / 'build', character, edition)
    for mount in ('root', 'runtime'):
        mounted = scan(candidate / mount)
        if mount == 'root' and mounted != {f['path']: f for f in proof['roots']}:
            raise ValueError('Root files changed after distribution assembly')
        if mount == 'runtime':
            runtime = json.loads((candidate / mount / 'runtime-manifest.json').read_text(encoding='utf-8'))
            if runtime['version'] != VERSION or {p: f for p, f in mounted.items() if p != 'runtime-manifest.json'} != {f['path']: f for f in runtime['files']}:
                raise ValueError('Runtime changed after distribution assembly')
        for meta in mounted.values():
            add(mount, mount, meta, candidate / mount)
    return trees, groups


def chunks_for(files):
    chunks, size = [[]], 0
    for f in files:
        if f['bytes'] > CHUNK_LIMIT:
            raise ValueError('Single file exceeds safe independent ZIP size: ' + f['path'])
        if size + f['bytes'] > CHUNK_LIMIT and chunks[-1]:
            chunks.append([])
            size = 0
        chunks[-1].append(f)
        size += f['bytes']
    return chunks


def verify_archive(path, files):
    with zipfile.ZipFile(path) as archive:
        if archive.namelist() != [f['path'] for f in files]:
            raise ValueError('ZIP file set/order mismatch: ' + path.name)
        for expected, info in zip(files, archive.infolist()):
            validate_path(info.filename)
            if info.file_size != expected['bytes'] or info.external_attr >> 16 & 0o170000 != 0o100000:
                raise ValueError('ZIP metadata mismatch: ' + info.filename)
            with archive.open(info) as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != expected['sha256']:
                    raise ValueError('ZIP payload hash mismatch: ' + info.filename)


def package(candidate, out, plan_only=False):
    trees, groups = group_trees(candidate)
    plan = {name: dict(files=len(g['files']), unpackedBytes=sum(f['bytes'] for f in g['files']), chunks=len(chunks_for(g['files']))) for name, g in sorted(groups.items())}
    out.mkdir(parents=True, exist_ok=True)
    save(out / 'packaging-plan.json', plan)
    if plan_only:
        return dict(ok=True, planOnly=True, groups=plan)
    manifest_path = out / ('install-manifest-' + VERSION + '.json')
    checkpoint_path = out / 'packaging-checkpoint.json'
    prior = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else (json.loads(checkpoint_path.read_text(encoding='utf-8')) if checkpoint_path.exists() else {})
    prior_packages = {p['id']: p for p in prior.get('packages', [])}
    packages, ids = [], {}
    for name, group in sorted(groups.items()):
        chunks = chunks_for(group['files'])
        ids[name] = []
        for ordinal, files in enumerate(chunks, 1):
            identifier = name + ('-' + str(ordinal) if len(chunks) > 1 else '')
            asset = 'AI-Buddy-' + VERSION + '-' + identifier + '.zip'
            path = out / asset
            previous = prior_packages.get(identifier)
            if previous and previous['files'] == files and path.exists() and path.stat().st_size == previous['bytes'] and sha(path) == previous['sha256']:
                verify_archive(path, files)
                packages.append(previous)
                ids[name].append(identifier)
                save(checkpoint_path, dict(appVersion=VERSION, packages=packages))
                print('Verified reuse ' + asset, flush=True)
                continue
            if path.exists():
                raise ValueError('Unverified existing package will not be overwritten: ' + str(path))
            temporary = path.with_suffix('.zip.partial')
            if temporary.exists():
                raise ValueError('Inspect prior interrupted package: ' + str(temporary))
            with zipfile.ZipFile(temporary, 'w', allowZip64=True, compresslevel=6) as archive:
                for f in files:
                    validate_path(f['path'])
                    info = zipfile.ZipInfo(f['path'], (2026, 10, 21, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    info.compress_type = zipfile.ZIP_STORED if Path(f['path']).suffix.lower() in MEDIA else zipfile.ZIP_DEFLATED
                    with (group['base'] / f['path']).open('rb') as src, archive.open(info, 'w', force_zip64=True) as dest:
                        shutil.copyfileobj(src, dest, 1024 * 1024)
            if temporary.stat().st_size > LIMIT:
                raise ValueError('Oversized ZIP: ' + asset)
            verify_archive(temporary, files)
            temporary.rename(path)
            item = dict(id=identifier, kind=name.split('-')[0], mount=group['mount'], assetName=asset, bytes=path.stat().st_size, unpackedBytes=sum(f['bytes'] for f in files), sha256=sha(path), filesSha256=index_hash(files), dependsOn=[], files=files)
            if group['characterId']:
                item['characterId'] = group['characterId']
            if group['edition']:
                item['edition'] = group['edition']
            packages.append(item)
            ids[name].append(identifier)
            save(checkpoint_path, dict(appVersion=VERSION, packages=packages))
            print(asset + ' ' + str(item['bytes']), flush=True)
    characters = []
    for identifier, name in NAMES.items():
        common = ids['character-' + identifier]
        if len(common) != 1:
            raise ValueError('Character common package must fit in one ZIP')
        characters.append(dict(id=identifier, name=name, commonPackageId=common[0], motions={e: ids['motion-' + identifier + '-' + e] for e in trees}))
    editions = []
    for edition in trees:
        app = ids['app-' + edition]
        if len(app) != 1:
            raise ValueError('Application code package must fit in one ZIP')
        editions.append(dict(id=edition, label=edition, appPackageId=app[0]))
    manifest = dict(schemaVersion=1, appVersion=VERSION, releaseTag='v' + VERSION, repository='lXiaoSel1/AI-Buddy', platform='win32', arch='x64', minimumInstallerVersion=VERSION, resourceContractVersion=1, defaultEdition='30fps', defaultCharacterId='deepseek', requiredPackageIds=ids['root'] + ids['runtime'] + ids['shared'], runtime=dict(executable='AI Buddy.exe', sha256=sha(candidate / 'runtime/AI Buddy.exe')), editions=editions, characters=characters, packages=packages)
    save(manifest_path, manifest)
    # Reconstruct each complete edition from package declarations, rejecting implicit overwrites.
    for edition in trees:
        selected = [p for p in packages if not p.get('edition') or p['edition'] == edition]
        for mount in ('build', 'root', 'runtime'):
            reconstructed = {}
            for item in selected:
                if item['mount'] == mount:
                    for f in item['files']:
                        if f['path'] in reconstructed:
                            raise ValueError('Implicit package overwrite: ' + f['path'])
                        reconstructed[f['path']] = f
            expected = trees[edition] if mount == 'build' else scan(candidate / mount)
            if reconstructed != expected:
                raise ValueError('Reconstructed candidate differs: ' + edition + '/' + mount)
    result = dict(ok=True, appVersion=VERSION, manifestSha256=sha(manifest_path), payloadVerification='all ZIP entries streamed and SHA-256 verified', packages=len(packages), maxPackageBytes=max(p['bytes'] for p in packages), totalAssetsBytes=sum(p['bytes'] for p in packages), editions={e: dict(downloadBytes=sum(p['bytes'] for p in packages if not p.get('edition') or p['edition'] == e), installedBytes=sum(p['unpackedBytes'] for p in packages if not p.get('edition') or p['edition'] == e)) for e in trees})
    save(out / 'packaging-result.json', result)
    return result


def portable(candidate, out, installer, work):
    """Produce a complete offline tree, verified full ZIP and <=1 GiB binary volumes."""
    manifest_path = out / ('install-manifest-' + VERSION + '.json')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    digest = sha(manifest_path)
    if manifest['appVersion'] != VERSION or manifest['releaseTag'] != 'v' + VERSION:
        raise ValueError('Wrong portable manifest')
    if work.exists():
        raise ValueError('Portable output must be new: ' + str(work))
    work.mkdir(parents=True)
    identity = work / 'installer-identity.json'
    result = subprocess.run([str(installer), '--headless', '--action=inspect', '--root=' + str(work / 'identity-probe'), '--receipt=' + str(identity)], check=True, capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    (work / 'installer-identity.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    if json.loads(identity.read_text(encoding='utf-8-sig'))['manifestSha256'] != digest:
        raise ValueError('Installer is not pinned to the fixed 1.9.0 manifest')
    installer_asset = out / ('AI-Buddy-Setup-' + VERSION + '-win-x64.exe')
    if installer_asset.exists() and sha(installer_asset) != sha(installer):
        raise ValueError('Existing installer asset differs')
    if not installer_asset.exists():
        shutil.copy2(installer, installer_asset)
    receipts = []
    for edition in ('30fps', '60fps'):
        tree = work / edition / 'AI-Buddy'
        build = 'builds/v' + VERSION + '-' + edition
        runtime = 'runtime/AI-Buddy-v' + VERSION
        manager = 'maintenance/' + VERSION + '/AI Buddy Setup.exe'
        for source, dest in ((candidate / 'root', tree), (candidate / edition / 'build', tree / build), (candidate / 'runtime', tree / runtime)):
            shutil.copytree(source, dest)
        (tree / manager).parent.mkdir(parents=True)
        shutil.copy2(installer, tree / manager)
        selected = [p for p in manifest['packages'] if not p.get('edition') or p['edition'] == edition]
        pointer = dict(version=VERSION, appVersion=VERSION, path=build, runtime=dict(path=runtime, **manifest['runtime']), animationProfile=edition, manifestSha256=digest)
        installation = dict(schemaVersion=1, version=VERSION, manifestSha256=digest, edition=edition, characters=[c['id'] for c in manifest['characters']], initialCharacter='deepseek', build=build, runtime=runtime, manager=manager, dataPath=None, pipe=None, dataInitialized=False, installedAt='2026-10-21T00:00:00Z', packageHashes={p['id']: p['sha256'] for p in selected})
        # A portable archive must never overwrite the user's selected data root.
        # The application only applies these program defaults when their complete
        # pointer binding matches the current build (not an online UUID build).
        save(tree / 'local/portable-defaults.json', dict(schemaVersion=1, pointer=pointer, installation=installation))
        save(tree / 'local/current-build.json', pointer)
        pin = 'local/install-manifests/' + digest + '.json'
        (tree / pin).parent.mkdir(parents=True)
        shutil.copy2(manifest_path, tree / pin)
        expected = {manager, 'local/portable-defaults.json', 'local/current-build.json', pin}
        for item in selected:
            prefix = '' if item['mount'] == 'root' else (build if item['mount'] == 'build' else runtime) + '/'
            expected.update(prefix + f['path'] for f in item['files'])
        index = list(scan(tree).values())
        if {f['path'] for f in index} != expected:
            raise ValueError('Portable tree has extra or missing files')
        indexed = {f['path']: f for f in index}
        for item in selected:
            prefix = '' if item['mount'] == 'root' else (build if item['mount'] == 'build' else runtime) + '/'
            for f in item['files']:
                if indexed[prefix + f['path']] != dict(f, path=prefix + f['path']):
                    raise ValueError('Portable payload differs from pinned manifest')
        archive = work / ('AI-Buddy-' + VERSION + '-Windows-x64-' + edition + '.zip')
        entries = [dict(f, path='AI-Buddy/' + f['path']) for f in index]
        with zipfile.ZipFile(archive, 'w', allowZip64=True, compresslevel=6) as zipped:
            for f, entry in zip(index, entries):
                validate_path(entry['path'])
                info = zipfile.ZipInfo(entry['path'], (2026, 10, 21, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_STORED if Path(f['path']).suffix.lower() in MEDIA else zipfile.ZIP_DEFLATED
                with (tree / f['path']).open('rb') as src, zipped.open(info, 'w', force_zip64=True) as target:
                    shutil.copyfileobj(src, target, 1024 * 1024)
        verify_archive(archive, entries)
        parts = []
        with archive.open('rb') as stream:
            while stream.tell() < archive.stat().st_size:
                part = out / (archive.name + '.part' + str(len(parts) + 1).zfill(2))
                if part.exists():
                    raise ValueError('Existing offline part will not be overwritten: ' + str(part))
                hasher, length = hashlib.sha256(), 0
                with part.open('xb') as target:
                    while length < LIMIT:
                        chunk = stream.read(min(4 * 1024 ** 2, LIMIT - length))
                        if not chunk:
                            break
                        target.write(chunk)
                        hasher.update(chunk)
                        length += len(chunk)
                parts.append(dict(file=part.name, bytes=length, sha256=hasher.hexdigest()))
        # Verify the binary concatenation as well as each independent source ZIP entry.
        combined = hashlib.sha256()
        for p in parts:
            with (out / p['file']).open('rb') as stream:
                while block := stream.read(4 * 1024 ** 2):
                    combined.update(block)
        if combined.hexdigest() != sha(archive):
            raise ValueError('Offline volumes do not reconstruct the verified full ZIP')
        receipt = dict(file=archive.name, bytes=archive.stat().st_size, sha256=sha(archive), parts=parts)
        save(out / (archive.name + '.parts.json'), receipt)
        save(work / ('portable-' + edition + '-files.json'), dict(ok=True, root=str(tree), files=index, archive=receipt))
        receipts.append(dict(edition=edition, installedBytes=sum(f['bytes'] for f in index), files=len(index), **receipt))
        save(work / 'offline-checkpoint.json', dict(ok=True, manifestSha256=digest, editions=receipts))
        print('Verified portable ' + edition + ': ' + str(len(parts)) + ' volumes', flush=True)
    merge = '''param([ValidateSet('30fps','60fps')][string]$Edition='30fps')
$ErrorActionPreference='Stop'
$folder=[IO.Path]::GetFullPath($PSScriptRoot)
$name='AI-Buddy-1.9.0-Windows-x64-'+$Edition+'.zip'
$receipt=Get-Content -LiteralPath (Join-Path $folder ($name+'.parts.json')) -Raw | ConvertFrom-Json
if($receipt.file -cne $name){throw 'Unexpected output name'}
$target=Join-Path $folder $name
if(Test-Path -LiteralPath $target){throw 'Output already exists; keep or move it before merging again'}
$temporary=$target+'.partial'
if(Test-Path -LiteralPath $temporary){throw 'An interrupted merge exists; inspect or remove only that partial file'}
foreach($part in $receipt.parts){
 if([IO.Path]::GetFileName($part.file) -cne $part.file -or $part.file -notmatch ('^'+[regex]::Escape($name)+'\\.part[0-9]{2}$')){throw 'Unsafe part name'}
 $path=Join-Path $folder $part.file
 if((Get-Item -LiteralPath $path).Length -ne $part.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $part.sha256){throw ('Part verification failed: '+$part.file)}
}
$output=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew)
try{foreach($part in $receipt.parts){$input=[IO.File]::OpenRead((Join-Path $folder $part.file));try{$input.CopyTo($output)}finally{$input.Dispose()}}}finally{$output.Dispose()}
if((Get-Item -LiteralPath $temporary).Length -ne $receipt.bytes -or (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.sha256){throw 'Combined ZIP verification failed'}
Move-Item -LiteralPath $temporary -Destination $target
Write-Host ('Verified: '+$target)
Write-Host 'Extract the complete ZIP and run AI Buddy.exe inside AI-Buddy.'
'''
    (out / ('Combine-AI-Buddy-' + VERSION + '.ps1')).write_text(merge, encoding='utf-8-sig')
    for edition in ('30fps', '60fps'):
        (out / ('Combine-AI-Buddy-' + VERSION + '-' + edition + '.cmd')).write_bytes(('@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Combine-AI-Buddy-' + VERSION + '.ps1" -Edition ' + edition + '\r\npause\r\n').encode('ascii'))
    result = dict(ok=True, version=VERSION, manifestSha256=digest, installerSha256=sha(installer), mediaReencoded=0, everyVolumeAtMostOneGiB=all(p['bytes'] <= LIMIT for e in receipts for p in e['parts']), editions=receipts)
    save(work / 'offline-packages.json', result)
    assets = {p['assetName'] for p in manifest['packages']}
    assets.update((manifest_path.name, installer_asset.name, 'Combine-AI-Buddy-' + VERSION + '.ps1'))
    for edition, receipt in zip(('30fps', '60fps'), receipts):
        assets.add('Combine-AI-Buddy-' + VERSION + '-' + edition + '.cmd')
        assets.add(receipt['file'] + '.parts.json')
        assets.update(p['file'] for p in receipt['parts'])
    sums = out / ('SHA256SUMS-' + VERSION + '.txt')
    sums.write_text(''.join(sha(out / name) + '  ' + name + '\n' for name in sorted(assets)), encoding='utf-8')
    assets.add(sums.name)
    save(work / 'release-assets-index.json', dict(version=VERSION, manifestSha256=digest, files=[dict(file=name, bytes=(out / name).stat().st_size, sha256=sha(out / name)) for name in sorted(assets)]))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--plan-only', action='store_true')
    parser.add_argument('--offline-only', action='store_true')
    parser.add_argument('--installer')
    parser.add_argument('--portable-output')
    args = parser.parse_args()
    candidate, output = Path(args.candidate).resolve(), Path(args.output).resolve()
    if args.offline_only:
        if not args.installer or not args.portable_output or args.plan_only:
            parser.error('--offline-only requires --installer and --portable-output without --plan-only')
        print(json.dumps(portable(candidate, output, Path(args.installer).resolve(), Path(args.portable_output).resolve()), ensure_ascii=False))
    else:
        print(json.dumps(package(candidate, output, args.plan_only), ensure_ascii=False))
