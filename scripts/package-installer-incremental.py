"""Repack current code/root while preserving pinned release media/runtime ZIP bytes.

The explicit root tree must already contain the current compiled portable launcher.
No installer, signature, tag or production installation is created by this command.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile

sys.dont_write_bytecode = True
from installer_release_inputs import compatible_resource_base, compatible_runtime_base, source_version, validate_manifest
from public_distribution_validation import OwnedOutput, boundaries, digest, file_map, no_links, read_json, require, scan_public

EDITIONS = ('30fps', '60fps')
LIMIT = 1024 ** 3
MEDIA = {'.webm', '.webp', '.png', '.jpg', '.jpeg', '.ico', '.zip'}
GALGAME_SHARED_FILES = (
    'assets/galgame-fonts/noto-serif-sc.woff2',
    'assets/galgame-fonts/cormorant-garamond-italic.woff2',
    'assets/galgame-fonts/OFL-Noto-Serif-SC.txt',
    'assets/galgame-fonts/OFL-Cormorant-Garamond.txt',
    'assets/group-scene/galgame-table.webp',
    'assets/group-scene/galgame-library.jpg',
)
LEGACY_STAGE_EXPRESSION = re.compile(r'assets/characters/v1710/[a-z]+/expressions/(?:cheerful|shy|serious|confused|angry|frightened|exasperated|starry)\.webp')


def builtin_asr_asset_rows(source):
    """Bind the built-in ASR files in the application ZIP to the build inputs."""
    if not (source / 'src/voice/builtin-asr-assets.mjs').exists():
        return {}
    inputs = [
        ('LICENSE.md', 'LICENSE.md', False),
        *[(name, 'release/voice-asr/' + name, True)
          for name in ('ASSET-NOTICES.md', 'downloads.json')],
        *[(name, 'sdk/plugins/voice-shared-runtime/' + name, False)
          for name in ('assets.json', 'asr.py', 'asr_worker.py', 'worker_protocol.py')],
    ]
    rows = {}
    for name, relative, normalize in inputs:
        raw = no_links(source / relative).read_bytes()
        if normalize:
            raw = raw.replace(b'\r\n', b'\n')
        path = 'assets/voice-asr/' + name
        rows[path] = dict(path=path, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    return rows


def galgame_asset_changes(source, base, tree, expected_assets, owners):
    """Accept only the pinned x2 portrait set and its shared offline assets."""
    catalog_module = no_links(source / 'src/character-expressions.generated.mjs').read_text(encoding='utf-8')
    inventory = re.search(r'^export const CHARACTER_EXPRESSION_IDS=(\[[^\n]*\]);$', catalog_module, re.MULTILINE)
    require(inventory is not None, 'Missing generated Galgame expression inventory')
    expression_ids = json.loads(inventory.group(1))
    require(expression_ids and all(isinstance(value, str) and re.fullmatch(r'[a-z-]+', value) for value in expression_ids)
            and len(set(expression_ids)) == len(expression_ids) and 'normal' in expression_ids,
            'Invalid generated Galgame expression inventory')
    declaration = 'export const CHARACTER_EXPRESSIONS='
    _, separator, data = catalog_module.partition(declaration)
    require(separator == declaration and data.rstrip().endswith(';'), 'Invalid generated Galgame catalog')
    catalog = json.loads(data.rstrip()[:-1])
    character_packages = {row['id']: row['commonPackageId'] for row in base['characters']}
    require(set(catalog) == set(character_packages) and len(catalog) == 11, 'Galgame character coverage differs')

    assets = {path: row for path, row in expected_assets.items() if not LEGACY_STAGE_EXPRESSION.fullmatch(path)}
    asset_owners = {path: owners[path] for path in assets}
    repacked = {identifier: [] for identifier in character_packages.values()}
    repacked['shared'] = []
    additions = {}
    for character, role in catalog.items():
        emotions = dict(normal=role['normal'], **role['expressions'])
        require(emotions.keys() == set(expression_ids), 'Galgame expression coverage differs: ' + character)
        for emotion, row in emotions.items():
            path = f'assets/characters/galgame-expressions/{character}/{emotion}.webp'
            require(row['src'] == './' + path and tree.get(path, {}).get('sha256') == row['sha256'], 'Galgame portrait identity differs: ' + path)
            additions[path] = tree[path]
            asset_owners[path] = character
            repacked[character_packages[character]].append(tree[path])
    for path in GALGAME_SHARED_FILES:
        asset = no_links(source / path)
        require(tree.get(path) == dict(path=path, bytes=asset.stat().st_size, sha256=digest(asset)), 'Galgame shared asset identity differs: ' + path)
        additions[path] = tree[path]
        asset_owners[path] = 'shared'
        repacked['shared'].append(tree[path])
    require(not assets.keys() & additions.keys(), 'Galgame asset overlay intersects the base')
    assets.update(additions)
    return assets, asset_owners, repacked


def index_digest(rows):
    return hashlib.sha256(''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in rows).encode()).hexdigest()


def package_incremental(source, base_manifest, base_sha256, builds, root_tree, output_root, receipt_root, *, galgame_expressions=False, local_galgame_base_version=None):
    source, base_manifest, root_tree, output_root, receipt_root = [Path(p).absolute() for p in (source, base_manifest, root_tree, output_root, receipt_root)]
    builds = {e: Path(builds[e]).absolute() for e in EDITIONS}
    boundaries(inputs=(source, base_manifest.parent, root_tree, *builds.values()), outputs=(output_root, receipt_root), fresh=(output_root, receipt_root))
    version = source_version(source)
    resource_base = compatible_resource_base(source, version)
    runtime_base = compatible_runtime_base(source, version, resource_base)
    require(digest(base_manifest) == base_sha256, 'Pinned base manifest SHA-256 differs')
    base = read_json(base_manifest)
    base_version = base.get('appVersion')
    if local_galgame_base_version is not None or galgame_expressions and base_version == version:
        require(galgame_expressions and base_version == version == local_galgame_base_version,
                'Pinned local Galgame overlay version does not match')
    else:
        require(isinstance(base_version, str) and tuple(map(int, base_version.split('.'))) < tuple(map(int, version.split('.'))),
                'Incremental release version must increase')
    validate_manifest(base_manifest, base_version, resource_base, runtime_base)
    replacements = {'root', *('app-' + e for e in EDITIONS)}
    require(replacements <= {p['id'] for p in base['packages']}, 'Pinned base lacks root or application packages')
    require(all(p['mount'] == ('root' if p['id'] == 'root' else 'build') for p in base['packages'] if p['id'] in replacements), 'Unexpected replaceable package layout')
    trees = {}
    code = {}
    coverage = {}
    resource_packages = {}
    builtin_asr_assets = builtin_asr_asset_rows(source)
    for edition, build in builds.items():
        tree = trees[edition] = scan_public(build)
        package = read_json(build / 'package.json')
        require(package.get('version') == version and package.get('animationProfile') == edition, 'Current code version/edition differs')
        reusable = [p for p in base['packages'] if p['id'] not in replacements and p['mount'] == 'build' and p.get('edition') in (None, edition)]
        resources = {f['path']: f for p in reusable for f in p['files']}
        current_assets = {path: row for path, row in tree.items() if path.startswith('assets/') and path != 'assets/install-resource-index.json'}
        selected_base = [p for p in base['packages'] if p['mount'] == 'build' and p.get('edition') in (None, edition)]
        owners = {f['path']: p.get('characterId', 'shared') for p in selected_base for f in p['files']}
        expected_assets = {f['path']: f for p in selected_base for f in p['files'] if f['path'].startswith('assets/') and f['path'] != 'assets/install-resource-index.json'}
        if galgame_expressions:
            expected_assets, asset_owners, additions = galgame_asset_changes(source, base, tree, expected_assets, owners)
            require(set(additions) <= {p['id'] for p in reusable if p.get('edition') is None}, 'Galgame overlay requires common build packages')
            for p in reusable:
                if p['id'] not in additions:
                    continue
                rows = [row for row in p['files'] if not LEGACY_STAGE_EXPRESSION.fullmatch(row['path'])] + additions[p['id']]
                rows.sort(key=lambda row: row['path'])
                require(p['id'] not in resource_packages or resource_packages[p['id']] == rows, 'Galgame overlay differs across editions')
                resource_packages[p['id']] = rows
            resources = {f['path']: f for p in reusable for f in resource_packages.get(p['id'], p['files'])}
        else:
            asset_owners = owners
        require(not builtin_asr_assets.keys() & resources.keys(), 'Built-in ASR files must belong to the application package')
        expected_assets.update(builtin_asr_assets)
        asset_owners.update(dict.fromkeys(builtin_asr_assets, 'shared'))
        require(current_assets == expected_assets, 'Current build asset coverage differs from pinned base packages: ' + edition)
        require(all(tree.get(path) == row for path, row in resources.items()), 'Current reusable resource bytes differ: ' + edition)
        index = read_json(build / 'assets/install-resource-index.json')
        require({k: v for k, v in index.items() if k not in ('shared', 'characters')} == dict(version=1, appVersion=version, edition=edition, defaultCharacter=base['defaultCharacterId']), 'Current resource index identity differs')
        characters = index.get('characters')
        require(isinstance(characters, dict) and set(characters) == {c['id'] for c in base['characters']}, 'Current resource index character coverage differs')
        indexed = [dict(row, owner=owner) for owner, rows in [('shared', index.get('shared', [])), *characters.items()] for row in rows]
        require(file_map(indexed, owners=True) == {path: dict(row, owner=asset_owners[path]) for path, row in expected_assets.items()}, 'Current resource index asset coverage differs')
        code[edition] = [row for path, row in tree.items() if path not in resources]
        coverage[edition] = dict(buildFiles=len(tree), reusedBuildFiles=len(resources) - sum(len(rows) for rows in resource_packages.values()), repackedCodeFiles=len(code[edition]), assetFiles=len(current_assets), complete=True)
        if resource_packages:
            coverage[edition]['repackedResourceFiles'] = sum(len(rows) for rows in resource_packages.values())
    require(set(trees['30fps']) == set(trees['60fps']), 'Current edition file sets differ')
    roots = list(scan_public(root_tree).values())
    require(bool(roots), 'Empty current root tree')
    require(digest(base_manifest) == base_sha256, 'Pinned base manifest changed during validation')
    output, receipts = OwnedOutput(output_root, fresh=True), OwnedOutput(receipt_root, fresh=True)
    output.directory(output_root, fresh=True)
    receipts.directory(receipt_root, fresh=True)
    packages, reused, repacked = [], [], []
    for previous in base['packages']:
        identifier = previous['id']
        if identifier not in replacements and identifier not in resource_packages:
            original = no_links(base_manifest.parent / previous['assetName'])
            target = output.target(output_root / previous['assetName'], fresh=True)
            os.link(original, target)
            require(os.path.samefile(original, target) and digest(target) == previous['sha256'], 'Hardlinked resource ZIP differs')
            packages.append(copy.deepcopy(previous))
            reused.append(dict(id=identifier, assetName=target.name, bytes=target.stat().st_size, sha256=previous['sha256'], hardlink=True))
            print('Reused ' + identifier, flush=True)
            continue
        edition = previous.get('edition')
        if identifier in resource_packages:
            rows, tree_root = resource_packages[identifier], builds['30fps']
        else:
            rows, tree_root = (roots, root_tree) if identifier == 'root' else (code[edition], builds[edition])
        asset = 'AI-Buddy-' + version + '-' + identifier + '.zip'
        target = output.target(output_root / asset, fresh=True)
        temporary = output.target(target.with_suffix('.zip.partial'), fresh=True)
        with zipfile.ZipFile(temporary, 'x', allowZip64=True, compresslevel=6) as archive:
            for row in rows:
                entry = zipfile.ZipInfo(row['path'], (2026, 10, 21, 0, 0, 0))
                entry.external_attr = 0o100644 << 16
                entry.compress_type = zipfile.ZIP_STORED if Path(row['path']).suffix.lower() in MEDIA else zipfile.ZIP_DEFLATED
                with no_links(tree_root / row['path']).open('rb') as src, archive.open(entry, 'w', force_zip64=True) as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
        require(temporary.stat().st_size <= LIMIT, 'Incremental ZIP exceeds release size limit')
        output.commit_file(temporary, target)
        item = dict(copy.deepcopy(previous), assetName=asset, bytes=target.stat().st_size, unpackedBytes=sum(f['bytes'] for f in rows), sha256=digest(target), filesSha256=index_digest(rows), files=rows)
        packages.append(item)
        repacked.append(dict(id=identifier, assetName=asset, files=len(rows), bytes=item['bytes'], sha256=item['sha256']))
        print('Repacked ' + identifier, flush=True)
    manifest = dict(copy.deepcopy(base), appVersion=version, releaseTag='v' + version, minimumInstallerVersion=version, packages=packages)
    manifest_path = output_root / ('install-manifest-' + version + '.json')
    output.write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', replace=False)
    validated = validate_manifest(manifest_path, version, resource_base, runtime_base)
    # The reconstructed mounts must cover every current file exactly once.
    for edition in EDITIONS:
        selected = [p for p in validated['packages'] if p.get('edition') in (None, edition)]
        build_rows = {f['path']: f for p in selected if p['mount'] == 'build' for f in p['files']}
        require(build_rows == trees[edition], 'Incremental package reconstruction differs: ' + edition)
    require(digest(base_manifest) == base_sha256, 'Pinned base manifest changed while packaging')
    checksums_path = output_root / ('SHA256SUMS-' + version + '.txt')
    assets = [manifest_path.name, *(p['assetName'] for p in packages)]
    output.write_text(checksums_path, ''.join(digest(output_root / name) + '  ' + name + '\n' for name in sorted(assets)), replace=False)
    result = dict(ok=True, version=version, resourceBaseVersion=resource_base, runtimeBaseVersion=runtime_base, baseManifest=str(base_manifest), baseManifestSha256=base_sha256, manifest=str(manifest_path), manifestSha256=digest(manifest_path), totalPackages=len(packages), reusedPackages=len(reused), repackedPackages=len(repacked), reusedBytes=sum(p['bytes'] for p in reused), repackedBytes=sum(p['bytes'] for p in repacked), totalPackageBytes=sum(p['bytes'] for p in packages), coverage=coverage, reused=reused, repacked=repacked, runtimeRepacked=False, mediaReencoded=0, payloadVerification='all final ZIP entries streamed and SHA-256 verified', installerIncluded=False, signingPerformed=False)
    receipts.write_text(receipt_root / 'packaging-result.json', json.dumps(result, ensure_ascii=False, indent=2) + '\n', replace=False)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--base-manifest', type=Path, required=True)
    parser.add_argument('--base-manifest-sha256', required=True)
    parser.add_argument('--build-30', type=Path, required=True)
    parser.add_argument('--build-60', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--receipts', type=Path, required=True)
    parser.add_argument('--galgame-expressions', action='store_true', help='Repack only the approved Galgame portraits and fonts into common resource packages')
    parser.add_argument('--local-galgame-base-version', help='Explicitly allow a Galgame overlay whose SHA-256-pinned base and source have this version')
    args = parser.parse_args()
    result = package_incremental(args.source, args.base_manifest, args.base_manifest_sha256, {'30fps': args.build_30, '60fps': args.build_60}, args.root, args.output, args.receipts, galgame_expressions=args.galgame_expressions, local_galgame_base_version=args.local_galgame_base_version)
    print(json.dumps({k: v for k, v in result.items() if k not in ('reused', 'repacked')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
