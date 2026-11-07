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
import shutil
import sys
import zipfile

sys.dont_write_bytecode = True
from installer_release_inputs import compatible_resource_base, compatible_runtime_base, source_version, validate_manifest
from public_distribution_validation import OwnedOutput, boundaries, digest, file_map, no_links, read_json, require, scan_public

EDITIONS = ('30fps', '60fps')
LIMIT = 1024 ** 3
MEDIA = {'.webm', '.webp', '.png', '.jpg', '.jpeg', '.ico', '.zip'}


def index_digest(rows):
    return hashlib.sha256(''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in rows).encode()).hexdigest()


def package_incremental(source, base_manifest, base_sha256, builds, root_tree, output_root, receipt_root):
    source, base_manifest, root_tree, output_root, receipt_root = [Path(p).absolute() for p in (source, base_manifest, root_tree, output_root, receipt_root)]
    builds = {e: Path(builds[e]).absolute() for e in EDITIONS}
    boundaries(inputs=(source, base_manifest.parent, root_tree, *builds.values()), outputs=(output_root, receipt_root), fresh=(output_root, receipt_root))
    version = source_version(source)
    resource_base = compatible_resource_base(source, version)
    runtime_base = compatible_runtime_base(source, version, resource_base)
    require(digest(base_manifest) == base_sha256, 'Pinned base manifest SHA-256 differs')
    base = read_json(base_manifest)
    base_version = base.get('appVersion')
    require(isinstance(base_version, str) and tuple(map(int, base_version.split('.'))) < tuple(map(int, version.split('.'))), 'Incremental release version must increase')
    validate_manifest(base_manifest, base_version, resource_base, runtime_base)
    replacements = {'root', *('app-' + e for e in EDITIONS)}
    require(replacements <= {p['id'] for p in base['packages']}, 'Pinned base lacks root or application packages')
    require(all(p['mount'] == ('root' if p['id'] == 'root' else 'build') for p in base['packages'] if p['id'] in replacements), 'Unexpected replaceable package layout')
    trees = {}
    code = {}
    coverage = {}
    for edition, build in builds.items():
        tree = trees[edition] = scan_public(build)
        package = read_json(build / 'package.json')
        require(package.get('version') == version and package.get('animationProfile') == edition, 'Current code version/edition differs')
        reusable = [p for p in base['packages'] if p['id'] not in replacements and p['mount'] == 'build' and p.get('edition') in (None, edition)]
        resources = {f['path']: f for p in reusable for f in p['files']}
        current_assets = {path: row for path, row in tree.items() if path.startswith('assets/') and path != 'assets/install-resource-index.json'}
        selected_base = [p for p in base['packages'] if p['mount'] == 'build' and p.get('edition') in (None, edition)]
        expected_assets = {f['path']: f for p in selected_base for f in p['files'] if f['path'].startswith('assets/') and f['path'] != 'assets/install-resource-index.json'}
        require(current_assets == expected_assets, 'Current build asset coverage differs from pinned base packages: ' + edition)
        require(all(tree.get(path) == row for path, row in resources.items()), 'Current reusable resource bytes differ: ' + edition)
        index = read_json(build / 'assets/install-resource-index.json')
        require({k: v for k, v in index.items() if k not in ('shared', 'characters')} == dict(version=1, appVersion=version, edition=edition, defaultCharacter=base['defaultCharacterId']), 'Current resource index identity differs')
        characters = index.get('characters')
        require(isinstance(characters, dict) and set(characters) == {c['id'] for c in base['characters']}, 'Current resource index character coverage differs')
        indexed = [dict(row, owner=owner) for owner, rows in [('shared', index.get('shared', [])), *characters.items()] for row in rows]
        owners = {f['path']: p.get('characterId', 'shared') for p in selected_base for f in p['files']}
        require(file_map(indexed, owners=True) == {path: dict(row, owner=owners[path]) for path, row in expected_assets.items()}, 'Current resource index asset coverage differs')
        code[edition] = [row for path, row in tree.items() if path not in resources]
        coverage[edition] = dict(buildFiles=len(tree), reusedBuildFiles=len(resources), repackedCodeFiles=len(code[edition]), assetFiles=len(current_assets), complete=True)
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
        if identifier not in replacements:
            original = no_links(base_manifest.parent / previous['assetName'])
            target = output.target(output_root / previous['assetName'], fresh=True)
            os.link(original, target)
            require(os.path.samefile(original, target) and digest(target) == previous['sha256'], 'Hardlinked resource ZIP differs')
            packages.append(copy.deepcopy(previous))
            reused.append(dict(id=identifier, assetName=target.name, bytes=target.stat().st_size, sha256=previous['sha256'], hardlink=True))
            print('Reused ' + identifier, flush=True)
            continue
        edition = previous.get('edition')
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
    args = parser.parse_args()
    result = package_incremental(args.source, args.base_manifest, args.base_manifest_sha256, {'30fps': args.build_30, '60fps': args.build_60}, args.root, args.output, args.receipts)
    print(json.dumps({k: v for k, v in result.items() if k not in ('reused', 'repacked')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
