"""Deterministic independent ZIPs for release trees with approved all-C 1.9.2 media; never encode media."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import zipfile
import sys
sys.dont_write_bytecode = True
from public_distribution_validation import APPLICATION_VERSION, boundaries, validated_trees, scan_public, OwnedOutput, no_links

VERSION = json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text(encoding='utf-8'))['version']
MEDIA_VERSION = '1.9.2'
LIMIT = 1024 ** 3
CHUNK_LIMIT = 950 * 1024 ** 2
NAMES = {'deepseek': 'DeepSeek', 'claude': 'Claude', 'grok': 'Grok', 'seed': 'Seed', 'kimi': 'Kimi', 'qwen': 'Qwen', 'minimax': 'MiniMax', 'chatgpt': 'GPT', 'gemini': 'Gemini', 'glm': 'GLM', 'hunyuan': '混元'}
MEDIA = {'.webm', '.webp', '.png', '.jpg', '.jpeg', '.ico', '.zip'}
APPROVED_MEDIA = '12ac599d424e678acb1c7f964c65551fdc48dc40ac31ea47facb253256a7b871'


def sha(path):
    path = no_links(path)
    if not path.is_file():
        raise ValueError('Hash source must be a regular file')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value, owner):
    owner.write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def scan(base, *, portable=False):
    return scan_public(base, allow_portable_defaults=portable)


def validate_path(name):
    p = PurePosixPath(name)
    if '\\' in name or ':' in name or p.is_absolute() or any(x in ('', '.', '..') for x in name.split('/')):
        raise ValueError('Unsafe archive path: ' + name)


def index_hash(files):
    return hashlib.sha256(''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in files).encode()).hexdigest()


def group_trees(candidate, *, inventory_path=None, inventory_sha256=None):
    if VERSION != APPLICATION_VERSION:
        raise ValueError('Packaging application version differs from this release gate')
    trees, owners, proof = validated_trees(candidate, inventory_path, inventory_sha256)
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


def verify_archive(path, files, owner):
    with zipfile.ZipFile(owner.target(path, required=True)) as archive:
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
    boundaries(inputs=(candidate, Path(__file__).absolute().parents[1]), outputs=(out,))
    output = OwnedOutput(out)
    trees, groups = group_trees(candidate)
    plan = {name: dict(files=len(g['files']), unpackedBytes=sum(f['bytes'] for f in g['files']), chunks=len(chunks_for(g['files']))) for name, g in sorted(groups.items())}
    output.directory(out)
    save(out / 'packaging-plan.json', plan, output)
    if plan_only:
        return dict(ok=True, planOnly=True, groups=plan)
    manifest_path = output.target(out / ('install-manifest-' + VERSION + '.json'))
    checkpoint_path = output.target(out / 'packaging-checkpoint.json')
    prior = output.read_json(manifest_path) if manifest_path.exists() else (output.read_json(checkpoint_path) if checkpoint_path.exists() else {})
    prior_packages = {p['id']: p for p in prior.get('packages', [])}
    packages, ids = [], {}
    for name, group in sorted(groups.items()):
        chunks = chunks_for(group['files'])
        ids[name] = []
        for ordinal, files in enumerate(chunks, 1):
            identifier = name + ('-' + str(ordinal) if len(chunks) > 1 else '')
            asset = 'AI-Buddy-' + VERSION + '-' + identifier + '.zip'
            path = output.target(out / asset)
            previous = prior_packages.get(identifier)
            if previous and previous['files'] == files and path.exists() and output.target(path, required=True).stat().st_size == previous['bytes'] and sha(path) == previous['sha256']:
                verify_archive(path, files, output)
                packages.append(previous)
                ids[name].append(identifier)
                save(checkpoint_path, dict(appVersion=VERSION, packages=packages), output)
                print('Verified reuse ' + asset, flush=True)
                continue
            if path.exists():
                raise ValueError('Unverified existing package will not be overwritten: ' + str(path))
            temporary = output.target(path.with_suffix('.zip.partial'), fresh=True)
            with zipfile.ZipFile(output.target(temporary, fresh=True), 'x', allowZip64=True, compresslevel=6) as archive:
                for f in files:
                    validate_path(f['path'])
                    info = zipfile.ZipInfo(f['path'], (2026, 10, 21, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    info.compress_type = zipfile.ZIP_STORED if Path(f['path']).suffix.lower() in MEDIA else zipfile.ZIP_DEFLATED
                    with (group['base'] / f['path']).open('rb') as src, archive.open(info, 'w', force_zip64=True) as dest:
                        shutil.copyfileobj(src, dest, 1024 * 1024)
            if output.target(temporary, required=True).stat().st_size > LIMIT:
                raise ValueError('Oversized ZIP: ' + asset)
            verify_archive(temporary, files, output)
            output.commit_file(temporary, path)
            item = dict(id=identifier, kind=name.split('-')[0], mount=group['mount'], assetName=asset, bytes=output.target(path, required=True).stat().st_size, unpackedBytes=sum(f['bytes'] for f in files), sha256=sha(path), filesSha256=index_hash(files), dependsOn=[], files=files)
            if group['characterId']:
                item['characterId'] = group['characterId']
            if group['edition']:
                item['edition'] = group['edition']
            packages.append(item)
            ids[name].append(identifier)
            save(checkpoint_path, dict(appVersion=VERSION, packages=packages), output)
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
    save(manifest_path, manifest, output)
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
    save(out / 'packaging-result.json', result, output)
    return result


def portable(candidate, out, installer, work):
    """Produce a complete offline tree, verified full ZIP and <=1 GiB binary volumes."""
    boundaries(inputs=(candidate, installer, Path(__file__).absolute().parents[1]), outputs=(out, work), fresh=(work,))
    output, working = OwnedOutput(out), OwnedOutput(work, fresh=True)
    group_trees(candidate)
    manifest_path = output.target(out / ('install-manifest-' + VERSION + '.json'), required=True)
    manifest = output.read_json(manifest_path)
    digest = sha(manifest_path)
    if manifest['appVersion'] != VERSION or manifest['releaseTag'] != 'v' + VERSION:
        raise ValueError('Wrong portable manifest')
    working.directory(work, fresh=True)
    identity = working.target(work / 'installer-identity.json', fresh=True)
    working.target(work / 'identity-probe', directory=True, fresh=True)
    result = subprocess.run([str(installer), '--headless', '--action=inspect', '--root=' + str(work / 'identity-probe'), '--receipt=' + str(identity)], check=True, capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    working.write_text(work / 'installer-identity.log', result.stdout + result.stderr, replace=False)
    if working.read_json(identity, encoding='utf-8-sig')['manifestSha256'] != digest:
        raise ValueError('Installer is not pinned to the fixed ' + VERSION + ' manifest')
    installer_asset = output.target(out / ('AI-Buddy-Setup-' + VERSION + '-win-x64.exe'))
    if installer_asset.exists() and sha(installer_asset) != sha(installer):
        raise ValueError('Existing installer asset differs')
    if not installer_asset.exists():
        output.copy_file(installer, installer_asset)
    receipts = []
    for edition in ('30fps', '60fps'):
        tree = work / edition / 'AI-Buddy'
        build = 'builds/v' + VERSION + '-' + edition
        runtime = 'runtime/AI-Buddy-v' + VERSION
        manager = 'maintenance/' + VERSION + '/AI Buddy Setup.exe'
        for source, dest in ((candidate / 'root', tree), (candidate / edition / 'build', tree / build), (candidate / 'runtime', tree / runtime)):
            working.copy_tree(source, dest)
        working.directory((tree / manager).parent)
        working.copy_file(installer, tree / manager)
        selected = [p for p in manifest['packages'] if not p.get('edition') or p['edition'] == edition]
        pointer = dict(version=VERSION, appVersion=VERSION, path=build, runtime=dict(path=runtime, **manifest['runtime']), animationProfile=edition, manifestSha256=digest)
        installation = dict(schemaVersion=1, version=VERSION, manifestSha256=digest, edition=edition, characters=[c['id'] for c in manifest['characters']], initialCharacter='deepseek', build=build, runtime=runtime, manager=manager, dataPath=None, pipe=None, dataInitialized=False, installedAt='2026-10-21T00:00:00Z', packageHashes={p['id']: p['sha256'] for p in selected})
        # A portable archive must never overwrite the user's selected data root.
        # The application only applies these program defaults when their complete
        # pointer binding matches the current build (not an online UUID build).
        save(tree / 'local/portable-defaults.json', dict(schemaVersion=1, pointer=pointer, installation=installation), working)
        save(tree / 'local/current-build.json', pointer, working)
        pin = 'local/install-manifests/' + digest + '.json'
        working.copy_file(output.target(manifest_path, required=True), tree / pin)
        expected = {manager, 'local/portable-defaults.json', 'local/current-build.json', pin}
        for item in selected:
            prefix = '' if item['mount'] == 'root' else (build if item['mount'] == 'build' else runtime) + '/'
            expected.update(prefix + f['path'] for f in item['files'])
        index = list(scan(tree, portable=True).values())
        if {f['path'] for f in index} != expected:
            raise ValueError('Portable tree has extra or missing files')
        indexed = {f['path']: f for f in index}
        for item in selected:
            prefix = '' if item['mount'] == 'root' else (build if item['mount'] == 'build' else runtime) + '/'
            for f in item['files']:
                if indexed[prefix + f['path']] != dict(f, path=prefix + f['path']):
                    raise ValueError('Portable payload differs from pinned manifest')
        archive = working.target(work / ('AI-Buddy-' + VERSION + '-Windows-x64-' + edition + '.zip'), fresh=True)
        entries = [dict(f, path='AI-Buddy/' + f['path']) for f in index]
        with zipfile.ZipFile(working.target(archive, fresh=True), 'x', allowZip64=True, compresslevel=6) as zipped:
            for f, entry in zip(index, entries):
                validate_path(entry['path'])
                info = zipfile.ZipInfo(entry['path'], (2026, 10, 21, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_STORED if Path(f['path']).suffix.lower() in MEDIA else zipfile.ZIP_DEFLATED
                with working.open_read(tree / f['path']) as src, zipped.open(info, 'w', force_zip64=True) as target:
                    shutil.copyfileobj(src, target, 1024 * 1024)
        verify_archive(archive, entries, working)
        parts = []
        with working.open_read(archive) as stream:
            while stream.tell() < working.target(archive, required=True).stat().st_size:
                part = output.target(out / (archive.name + '.part' + str(len(parts) + 1).zfill(2)), fresh=True)
                hasher, length = hashlib.sha256(), 0
                with output.target(part, fresh=True).open('xb') as target:
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
            with output.open_read(out / p['file']) as stream:
                while block := stream.read(4 * 1024 ** 2):
                    combined.update(block)
        if combined.hexdigest() != sha(archive):
            raise ValueError('Offline volumes do not reconstruct the verified full ZIP')
        receipt = dict(file=archive.name, bytes=working.target(archive, required=True).stat().st_size, sha256=sha(archive), parts=parts)
        save(out / (archive.name + '.parts.json'), receipt, output)
        save(work / ('portable-' + edition + '-files.json'), dict(ok=True, root=str(tree), files=index, archive=receipt), working)
        receipts.append(dict(edition=edition, installedBytes=sum(f['bytes'] for f in index), files=len(index), **receipt))
        save(work / 'offline-checkpoint.json', dict(ok=True, manifestSha256=digest, editions=receipts), working)
        print('Verified portable ' + edition + ': ' + str(len(parts)) + ' volumes', flush=True)
    merge = '''param([ValidateSet('30fps','60fps')][string]$Edition='30fps')
$ErrorActionPreference='Stop'
$folder=[IO.Path]::GetFullPath($PSScriptRoot)
$name='AI-Buddy-@VERSION@-Windows-x64-'+$Edition+'.zip'
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
    output.write_text(out / ('Combine-AI-Buddy-' + VERSION + '.ps1'), merge.replace('@VERSION@', VERSION), encoding='utf-8-sig')
    for edition in ('30fps', '60fps'):
        output.write_bytes(out / ('Combine-AI-Buddy-' + VERSION + '-' + edition + '.cmd'), ('@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Combine-AI-Buddy-' + VERSION + '.ps1" -Edition ' + edition + '\r\npause\r\n').encode('ascii'))
    result = dict(ok=True, version=VERSION, manifestSha256=digest, installerSha256=sha(installer), mediaReencoded=0, everyVolumeAtMostOneGiB=all(p['bytes'] <= LIMIT for e in receipts for p in e['parts']), editions=receipts)
    save(work / 'offline-packages.json', result, working)
    assets = {p['assetName'] for p in manifest['packages']}
    assets.update((manifest_path.name, installer_asset.name, 'Combine-AI-Buddy-' + VERSION + '.ps1'))
    for edition, receipt in zip(('30fps', '60fps'), receipts):
        assets.add('Combine-AI-Buddy-' + VERSION + '-' + edition + '.cmd')
        assets.add(receipt['file'] + '.parts.json')
        assets.update(p['file'] for p in receipt['parts'])
    sums = out / ('SHA256SUMS-' + VERSION + '.txt')
    output.write_text(sums, ''.join(sha(output.target(out / name, required=True)) + '  ' + name + '\n' for name in sorted(assets)))
    assets.add(sums.name)
    save(work / 'release-assets-index.json', dict(version=VERSION, manifestSha256=digest, files=[dict(file=name, bytes=output.target(out / name, required=True).stat().st_size, sha256=sha(output.target(out / name, required=True))) for name in sorted(assets)]), working)
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
    candidate, output = Path(args.candidate).absolute(), Path(args.output).absolute()
    if args.offline_only:
        if not args.installer or not args.portable_output or args.plan_only:
            parser.error('--offline-only requires --installer and --portable-output without --plan-only')
        print(json.dumps(portable(candidate, output, Path(args.installer).absolute(), Path(args.portable_output).absolute()), ensure_ascii=False))
    else:
        print(json.dumps(package(candidate, output, args.plan_only), ensure_ascii=False))
