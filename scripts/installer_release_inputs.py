"""Artifact checks shared by installer preparation, portable packaging and preflight."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

from public_distribution_validation import OwnedOutput, boundaries, file_map, no_links, public_path, require

STABLE = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'


def read_json(path):
    return json.loads(no_links(path).read_text(encoding='utf-8-sig'))


def sha256(path):
    path = no_links(path)
    if not path.is_file():
        raise ValueError('Hash source must be a regular file')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inspect_installer(installer, manifest_path, work, version):
    """Run the actual binary before claiming either supported protocol."""
    installer, manifest_path = no_links(installer), no_links(manifest_path)
    before = sha256(installer)
    digest = sha256(manifest_path)
    output = OwnedOutput(work)
    output.directory(work)
    receipt = output.target(work / 'installer-identity.json', fresh=True)
    probe = output.target(work / 'identity-probe', directory=True, fresh=True)
    result = subprocess.run([str(installer), '--headless', '--action=inspect', '--root=' + str(probe), '--receipt=' + str(receipt)], check=False, capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    output.write_text(work / 'installer-identity.log', result.stdout + result.stderr, replace=False)
    result.check_returncode()
    identity = output.read_json(receipt, encoding='utf-8-sig')
    if not isinstance(identity, dict) or identity.get('ok') is not True or identity.get('version') != version or identity.get('manifestSha256') != digest:
        raise ValueError('Installer inspect version/manifest identity mismatch')
    if any(type(identity.get(name)) is not int or identity[name] != 1 for name in ('appUpdateProtocol', 'appBootstrapProtocol')):
        raise ValueError('Installer inspect must confirm app update and bootstrap protocol 1')
    after = sha256(installer)
    if before != after:
        raise ValueError('Installer changed during capability inspection')
    return dict(identity=identity, managerSha256=after, managerProtocol=identity['appUpdateProtocol'])


def source_version(source):
    version = read_json(source / 'package.json').get('version')
    require(isinstance(version, str) and re.fullmatch(STABLE, version), 'Invalid application version')
    lock = read_json(source / 'package-lock.json')
    require(lock.get('version') == version and lock.get('packages', {}).get('', {}).get('version') == version, 'Package lock version differs')
    project = ET.fromstring(no_links(source / 'installer/AI.Buddy.Setup.csproj').read_bytes())
    require([v.text for v in project.findall('.//Version')] == [version], 'Installer project version differs')
    require([v.text for v in project.findall('.//AssemblyName')] == ['AI-Buddy-Setup-' + version + '-win-x64'], 'Installer assembly version differs')
    identity = no_links(source / 'installer/Core/ReleaseIdentity.cs').read_text(encoding='utf-8-sig')
    require(re.findall(r'\bconst\s+string\s+Version\s*=\s*"([^"]+)"', identity) == [version], 'ReleaseIdentity version differs')
    return version


def compatible_resource_base(source, version):
    state_path = source / 'release.json'
    if not state_path.exists():
        return version
    state = read_json(state_path)
    require(isinstance(state, dict) and state.get('schemaVersion') == 1 and state.get('version') == version, 'Resource compatibility source version differs')
    base = state.get('resourceBaseVersion')
    require(isinstance(base, str) and re.fullmatch(STABLE, base) and tuple(map(int, base.split('.'))) <= tuple(map(int, version.split('.'))), 'Invalid resource base version')
    return base


def compatible_runtime_base(source, version, resource_base_version=None):
    """Runtime identity can predate the separately declared media resource base."""
    fallback = compatible_resource_base(source, version) if resource_base_version is None else resource_base_version
    state_path = source / 'release.json'
    if not state_path.exists():
        return fallback
    state = read_json(state_path)
    require(isinstance(state, dict) and state.get('schemaVersion') == 1 and state.get('version') == version, 'Runtime compatibility source version differs')
    base = state.get('runtimeBaseVersion', fallback)
    require(isinstance(base, str) and re.fullmatch(STABLE, base) and tuple(map(int, base.split('.'))) <= tuple(map(int, version.split('.'))), 'Invalid runtime base version')
    return base


def validate_manifest(manifest_path, version, resource_base_version=None, runtime_base_version=None):
    """Check final manifest and real ZIP bytes, including embedded code identities."""
    manifest_path = no_links(manifest_path)
    resource_base_version = version if resource_base_version is None else resource_base_version
    require(isinstance(resource_base_version, str) and re.fullmatch(STABLE, resource_base_version) and tuple(map(int, resource_base_version.split('.'))) <= tuple(map(int, version.split('.'))), 'Invalid resource base version')
    runtime_base_version = resource_base_version if runtime_base_version is None else runtime_base_version
    require(isinstance(runtime_base_version, str) and re.fullmatch(STABLE, runtime_base_version) and tuple(map(int, runtime_base_version.split('.'))) <= tuple(map(int, version.split('.'))), 'Invalid runtime base version')
    require(manifest_path.name == 'install-manifest-' + version + '.json', 'Final manifest filename/version differs')
    require(manifest_path.stat().st_size <= 16 * 1024 ** 2, 'Oversized manifest')
    m = read_json(manifest_path)
    require(isinstance(m, dict) and 'templateOnly' not in m, 'Template is not a final manifest')
    require(all(m.get(key) == value for key, value in dict(schemaVersion=1, appVersion=version, releaseTag='v' + version, repository='lXiaoSel1/AI-Buddy', platform='win32', arch='x64', minimumInstallerVersion=version, resourceContractVersion=1).items()), 'Manifest version/platform differs')
    packages = m.get('packages')
    require(isinstance(packages, list) and 1 <= len(packages) <= 900, 'Missing final packages')
    ids, assets, code_editions, runtime_manifests = {}, set(), set(), []
    for p in packages:
        identifier, asset = p.get('id', ''), p.get('assetName', '')
        require(re.fullmatch(r'[a-z0-9-]{1,100}', identifier) and identifier not in ids, 'Invalid or duplicate package id')
        public_path(asset)
        require('/' not in asset and re.fullmatch(r'AI-Buddy-' + STABLE + r'-.+\.zip', asset) and asset.casefold() not in assets, 'Invalid package asset version/name')
        ids[identifier] = p; assets.add(asset.casefold())
        rows = file_map(p.get('files'))
        require(1 <= len(rows) <= 20000 and p.get('mount') in ('root', 'runtime', 'build'), 'Invalid package layout')
        require(p.get('unpackedBytes') == sum(f['bytes'] for f in rows.values()), 'Expanded package size differs')
        index = ''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in rows.values()).encode()
        require(p.get('filesSha256') == hashlib.sha256(index).hexdigest(), 'Package file index hash differs')
        actual = no_links(manifest_path.parent / asset)
        require(type(p.get('bytes')) is int and 0 < p['bytes'] <= 1024 ** 3 and actual.stat().st_size == p['bytes'] and sha256(actual) == p.get('sha256'), 'Package artifact SHA-256/size differs: ' + asset)
        with zipfile.ZipFile(actual) as archive:
            require(archive.namelist() == list(rows), 'Package archive file set/order differs')
            for info in archive.infolist():
                expected = rows[info.filename]
                require(not info.is_dir() and info.file_size == expected['bytes'] and info.external_attr >> 16 & 0o170000 in (0, 0o100000), 'Invalid package archive metadata')
                with archive.open(info) as stream:
                    require(hashlib.file_digest(stream, 'sha256').hexdigest() == expected['sha256'], 'Package payload SHA-256 differs')
                if info.filename == 'package.json' and p['mount'] == 'build':
                    code = json.loads(archive.read(info))
                    require(code.get('version') == version and p.get('edition') in ('30fps', '60fps') and code.get('animationProfile') == p['edition'], 'Packaged application version/edition differs')
                    code_editions.add(p['edition'])
                if info.filename == 'runtime-manifest.json' and p['mount'] == 'runtime':
                    runtime_manifest = json.loads(archive.read(info))
                    require(runtime_manifest.get('version') in (version, runtime_base_version), 'Packaged runtime version differs from application or declared runtime base')
                    runtime_manifests.append(runtime_manifest)
    require(code_editions == {'30fps', '60fps'} and len(runtime_manifests) == 1, 'Missing complete application/runtime identities')
    runtime_rows = [f for p in packages if p['mount'] == 'runtime' for f in p['files'] if f['path'] != 'runtime-manifest.json']
    require(file_map(runtime_manifests[0].get('files')) == file_map(runtime_rows), 'Packaged runtime file inventory differs')
    require(m.get('runtime', {}).get('executable') == 'AI Buddy.exe' and any(p['mount'] == 'runtime' and any(f['path'] == 'AI Buddy.exe' and f['sha256'] == m['runtime'].get('sha256') for f in p['files']) for p in packages), 'Manifest runtime identity differs')
    editions, characters = m.get('editions'), m.get('characters')
    require(isinstance(editions, list) and len(editions) == 2 and {e.get('id') for e in editions} == {'30fps', '60fps'}, 'Invalid edition catalogue')
    require(isinstance(characters, list) and len(characters) > 0 and len({c.get('id') for c in characters}) == len(characters) and any(c.get('id') == m.get('defaultCharacterId') for c in characters) and m.get('defaultEdition') in ('30fps', '60fps'), 'Invalid character catalogue')
    for edition in editions:
        selected, active, paths = set(), set(), set()

        def visit(identifier):
            require(identifier in ids and identifier not in active, 'Missing/cyclic package dependency')
            if identifier in selected:
                return
            active.add(identifier)
            p = ids[identifier]
            require(p.get('edition') in (None, edition['id']), 'Mixed package editions')
            require(isinstance(p.get('dependsOn'), list), 'Missing package dependencies')
            for dependency in p['dependsOn']:
                visit(dependency)
            for f in p['files']:
                key = (p['mount'] + '/' + f['path']).casefold()
                require(key not in paths, 'Overlapping package files')
                paths.add(key)
            active.remove(identifier); selected.add(identifier)

        require(isinstance(m.get('requiredPackageIds'), list), 'Missing required packages')
        required = m['requiredPackageIds'] + [edition.get('appPackageId')]
        for character in characters:
            require(re.fullmatch(r'[a-z0-9-]+', character.get('id', '')) and isinstance(character.get('motions', {}).get(edition['id']), list), 'Invalid character dependencies')
            required += [character.get('commonPackageId')] + character['motions'][edition['id']]
        for identifier in required:
            visit(identifier)
    return m


def prepare_installer_inputs(source, manifest_path, output_root):
    """Stage only installer sources/licenses/icon; never copy or re-encode media."""
    source, manifest_path, output_root = map(lambda p: Path(p).absolute(), (source, manifest_path, output_root))
    boundaries(inputs=(source, manifest_path.parent), outputs=(output_root,), fresh=(output_root,))
    version = source_version(source)
    resource_base_version = compatible_resource_base(source, version)
    runtime_base_version = compatible_runtime_base(source, version, resource_base_version)
    digest = sha256(manifest_path)
    validate_manifest(manifest_path, version, resource_base_version, runtime_base_version)
    require(sha256(manifest_path) == digest, 'Final manifest changed during validation')
    output = OwnedOutput(output_root, fresh=True)
    output.directory(output_root, fresh=True)
    staging = output_root / 'source'
    names = {'AI.Buddy.Setup.csproj', 'global.json', 'packages.lock.json', 'app.manifest'}
    for directory, dirs, files in os.walk(source / 'installer'):
        dirs[:] = [d for d in dirs if d.casefold() not in ('bin', 'obj', 'tests', 'generated')]
        for name in files:
            if name == 'BuildIdentity.g.cs' or not (name.endswith('.cs') or name in names):
                continue
            original = no_links(Path(directory) / name)
            output.copy_file(original, staging / original.relative_to(source))
    output.copy_file(source / 'assets/branding/app.ico', staging / 'assets/branding/app.ico')
    licenses = list((source / 'licenses').glob('DOTNET-*.txt'))
    require(bool(licenses), 'Missing .NET licenses')
    for license_file in licenses:
        output.copy_file(license_file, staging / 'licenses' / license_file.name)
    output.copy_file(manifest_path, staging / 'installer/generated/install-manifest.json')
    require(sha256(staging / 'installer/generated/install-manifest.json') == digest, 'Final manifest changed while staging')
    output.write_text(staging / 'installer/BuildIdentity.g.cs', 'namespace AiBuddy.Install;\r\npublic static class BuildIdentity { public const string ManifestSha256="' + digest + '"; }\r\n', replace=False)
    project = staging / 'installer/AI.Buddy.Setup.csproj'
    command = ['dotnet', 'publish', str(project), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:RestoreLockedMode=true', '-o', str(output_root / 'publish'), '-p:BaseIntermediateOutputPath=' + str(output_root / 'obj') + os.sep, '-p:MSBuildProjectExtensionsPath=' + str(output_root / 'obj') + os.sep, '-p:BaseOutputPath=' + str(output_root / 'bin') + os.sep]
    result = dict(ok=True, version=version, resourceBaseVersion=resource_base_version, runtimeBaseVersion=runtime_base_version, manifestSha256=digest, project=str(project), command=command, installer=str(output_root / 'publish' / ('AI-Buddy-Setup-' + version + '-win-x64.exe')), mediaCopied=0, mediaReencoded=0)
    output.write_text(output_root / 'installer-inputs.json', json.dumps(result, indent=2) + '\n', replace=False)
    return result


def release_preflight(source, manifest_path, installer, checksums, source_commit, output_root, tag_message=None):
    """Prepare an unsigned tag message only after checking actual release artifacts."""
    source, manifest_path, installer, checksums, output_root = map(lambda p: Path(p).absolute(), (source, manifest_path, installer, checksums, output_root))
    boundaries(inputs=(source, manifest_path.parent), outputs=(output_root,), fresh=(output_root,))
    require(isinstance(source_commit, str) and re.fullmatch(r'[a-f0-9]{40}', source_commit), 'Source must be a full lowercase commit SHA')
    version = source_version(source)
    resource_base_version = compatible_resource_base(source, version)
    runtime_base_version = compatible_runtime_base(source, version, resource_base_version)
    manifest = validate_manifest(manifest_path, version, resource_base_version, runtime_base_version)
    require(installer.parent == manifest_path.parent and installer.name == 'AI-Buddy-Setup-' + version + '-win-x64.exe', 'Installer release filename/location differs')
    require(checksums.parent == manifest_path.parent and checksums.name == 'SHA256SUMS-' + version + '.txt', 'Checksums release filename/location differs')
    entries = {}
    for line in no_links(checksums).read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        require(match is not None, 'Invalid checksums table line')
        digest, name = match.groups()
        public_path(name)
        require('/' not in name and name.casefold() not in entries and name != checksums.name, 'Duplicate/unsafe checksums asset')
        allowed = name in (manifest_path.name, installer.name, *(p['assetName'] for p in manifest['packages'])) or name.startswith(('AI-Buddy-' + version + '-', 'Combine-AI-Buddy-' + version + '.','Combine-AI-Buddy-' + version + '-'))
        require(allowed, 'Checksums asset belongs to another release: ' + name)
        entries[name.casefold()] = dict(file=name, sha256=digest)
    required = {manifest_path.name, installer.name, *(p['assetName'] for p in manifest['packages'])}
    require(all(name.casefold() in entries and entries[name.casefold()]['file'] == name for name in required), 'Release checksums are missing required artifacts')
    for row in entries.values():
        actual = no_links(manifest_path.parent / row['file'])
        require(sha256(actual) == row['sha256'], 'Checksums artifact SHA-256 differs: ' + row['file'])
        row['bytes'] = actual.stat().st_size
    bindings = {
        'Source': source_commit,
        'Installer SHA-256': entries[installer.name.casefold()]['sha256'],
        'Manifest SHA-256': entries[manifest_path.name.casefold()]['sha256'],
        'Checksums SHA-256': sha256(checksums),
        'App Update Protocol': '1',
        'App Bootstrap Protocol': '1',
    }
    if tag_message is None:
        tag_message = 'AI Buddy v' + version + '\n\n' + ''.join(key + ': ' + value + '\n' for key, value in bindings.items())
    require(isinstance(tag_message, str), 'Invalid proposed tag text')
    for key, value in bindings.items():
        require(re.findall(r'^' + re.escape(key) + r': (.*)$', tag_message, flags=re.MULTILINE) == [value], 'Proposed tag binding differs or is missing: ' + key)
    output = OwnedOutput(output_root, fresh=True)
    output.directory(output_root, fresh=True)
    identity = inspect_installer(installer, manifest_path, output_root / 'inspect', version)
    require(identity['managerSha256'] == bindings['Installer SHA-256'] and sha256(manifest_path) == bindings['Manifest SHA-256'] and sha256(checksums) == bindings['Checksums SHA-256'], 'Release identity changed during preflight')
    draft = output_root / ('unsigned-tag-v' + version + '.txt')
    output.write_text(draft, tag_message, replace=False)
    result = dict(ok=True, version=version, resourceBaseVersion=resource_base_version, runtimeBaseVersion=runtime_base_version, sourceCommit=source_commit, manifestSha256=bindings['Manifest SHA-256'], installerSha256=identity['managerSha256'], checksumsSha256=bindings['Checksums SHA-256'], appUpdateProtocol=1, appBootstrapProtocol=1, inspectedInstaller=identity['identity'], artifacts=list(entries.values()), unsignedTagMessage=str(draft), signingPerformed=False)
    output.write_text(output_root / 'release-preflight.json', json.dumps(result, indent=2) + '\n', replace=False)
    return result
