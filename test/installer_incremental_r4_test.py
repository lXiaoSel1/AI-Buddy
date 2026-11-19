"""Incremental release artifact seam: real local ZIPs, no network or installation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import subprocess
from unittest.mock import patch
import unittest
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
spec = importlib.util.spec_from_file_location('incremental', Path(__file__).resolve().parents[1] / 'scripts/package-installer-incremental.py')
incremental = importlib.util.module_from_spec(spec)
spec.loader.exec_module(incremental)
portable_spec = importlib.util.spec_from_file_location('portable_packaging', Path(__file__).resolve().parents[1] / 'scripts/package-installer-202.py')
portable_packaging = importlib.util.module_from_spec(portable_spec)
portable_spec.loader.exec_module(portable_packaging)


class IncrementalReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='buddy-incremental-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.version = portable_packaging.VERSION
        self.source = self.root / 'source'; self.source.mkdir()
        files = {
            'package.json': {'version': self.version},
            'package-lock.json': {'version': self.version, 'packages': {'': {'version': self.version}}},
            'release.json': {'schemaVersion': 1, 'version': self.version, 'resourceBaseVersion': '2.0.5', 'runtimeBaseVersion': '2.0.4'},
        }
        for name, value in files.items():
            (self.source / name).write_text(json.dumps(value))
        (self.source / 'installer/Core').mkdir(parents=True)
        (self.source / 'installer/AI.Buddy.Setup.csproj').write_text(f'<Project><Version>{self.version}</Version><AssemblyName>AI-Buddy-Setup-{self.version}-win-x64</AssemblyName></Project>')
        (self.source / 'installer/Core/ReleaseIdentity.cs').write_text(f'public const string Version="{self.version}";')
        self.base = self.root / 'base'; self.base.mkdir()
        packages = []
        def package(identifier, mount, content, edition=None):
            path = self.base / ('AI-Buddy-2.0.7-' + identifier + '.zip')
            rows = []
            with zipfile.ZipFile(path, 'w') as archive:
                for name, value in sorted(content.items()):
                    data = value if isinstance(value, bytes) else json.dumps(value).encode()
                    archive.writestr(name, data)
                    rows.append(dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
            item = dict(id=identifier, kind=identifier.split('-')[0], mount=mount, assetName=path.name, bytes=path.stat().st_size, unpackedBytes=sum(f['bytes'] for f in rows), sha256=hashlib.sha256(path.read_bytes()).hexdigest(), filesSha256=hashlib.sha256(''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in rows).encode()).hexdigest(), files=rows, dependsOn=[])
            if edition: item['edition'] = edition
            packages.append(item)
        runtime_data = b'runtime remains version five'
        runtime_row = dict(path='AI Buddy.exe', bytes=len(runtime_data), sha256=hashlib.sha256(runtime_data).hexdigest())
        package('runtime', 'runtime', {'AI Buddy.exe': runtime_data, 'runtime-manifest.json': {'version': '2.0.4', 'files': [runtime_row]}})
        package('root', 'root', {'README.md': b'old root'})
        package('shared', 'build', {'assets/picture.png': b'stable media'})
        shared_row = packages[-1]['files'][0]
        self.builds = {}
        for edition in ['30fps', '60fps']:
            metadata = json.dumps({'edition': edition}).encode()
            metadata_row = dict(path='assets/character-sequence-manifest.json', bytes=len(metadata), sha256=hashlib.sha256(metadata).hexdigest())
            content = {'assets/character-sequence-manifest.json': metadata, 'package.json': {'version': '2.0.7', 'animationProfile': edition}, 'main.cjs': b'old code', 'assets/install-resource-index.json': {'version': 1, 'appVersion': '2.0.7', 'edition': edition, 'defaultCharacter': 'deepseek', 'shared': [shared_row, metadata_row], 'characters': {'deepseek': []}}}
            package('app-' + edition, 'build', content, edition)
            build = self.root / edition; (build / 'assets').mkdir(parents=True)
            for name, value in content.items():
                if isinstance(value, dict):
                    value = dict(value, **({'version': self.version} if name == 'package.json' else {'appVersion': self.version}))
                    data = json.dumps(value).encode()
                else: data = b'new code' if name == 'main.cjs' else value
                (build / name).write_bytes(data)
            (build / 'assets/picture.png').write_bytes(b'stable media')
            (build / 'new-worker.cjs').write_bytes(b'new public worker included')
            self.builds[edition] = build
        manifest = dict(schemaVersion=1, appVersion='2.0.7', releaseTag='v2.0.7', repository='lXiaoSel1/AI-Buddy', platform='win32', arch='x64', minimumInstallerVersion='2.0.7', resourceContractVersion=1, defaultEdition='30fps', defaultCharacterId='deepseek', requiredPackageIds=['root', 'runtime', 'shared'], runtime={'executable': 'AI Buddy.exe', 'sha256': runtime_row['sha256']}, editions=[dict(id=e, label=e, appPackageId='app-' + e) for e in self.builds], characters=[dict(id='deepseek', name='DeepSeek', commonPackageId='shared', motions={e: [] for e in self.builds})], packages=packages)
        self.manifest = self.base / 'install-manifest-2.0.7.json'
        self.manifest.write_text(json.dumps(manifest))
        self.base_sha = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.roots = self.root / 'roots'; self.roots.mkdir()
        (self.roots / 'README.md').write_bytes(b'current root')
        self.out, self.work = self.root / 'release', self.root / 'receipts'

    def run_package(self):
        return incremental.package_incremental(self.source, self.manifest, self.base_sha, self.builds, self.roots, self.out, self.work)

    def test_builtin_asr_is_source_bound_and_owned_by_each_app_package(self):
        repository = Path(__file__).resolve().parents[1]
        (self.source / 'src/voice').mkdir(parents=True)
        (self.source / 'src/voice/builtin-asr-assets.mjs').touch()
        self.add_asr_inputs(repository)
        rows = incremental.builtin_asr_asset_rows(self.source)
        self.assertEqual(len(rows), 7)
        for build in self.builds.values():
            index_path = build / 'assets/install-resource-index.json'
            index = json.loads(index_path.read_text())
            index['shared'].extend(rows.values())
            index_path.write_text(json.dumps(index))
            for path in rows:
                target = build / path
                target.parent.mkdir(exist_ok=True)
                name = target.name
                source = next(self.source.rglob(name))
                raw = source.read_bytes()
                if name in ('ASSET-NOTICES.md', 'downloads.json'):
                    raw = raw.replace(b'\r\n', b'\n')
                target.write_bytes(raw)
        changed = self.builds['60fps'] / 'assets/voice-asr/asr.py'
        initial = changed.read_bytes()
        changed.write_bytes(initial + b'\n')
        with self.assertRaisesRegex(ValueError, 'asset coverage differs'):
            self.run_package()
        changed.write_bytes(initial)
        self.run_package()
        for edition in self.builds:
            with zipfile.ZipFile(self.out / f'AI-Buddy-{self.version}-app-{edition}.zip') as archive:
                self.assertTrue(rows.keys() <= set(archive.namelist()))

    def add_asr_inputs(self, repository):
        files = (
            'LICENSE.md', 'release/voice-asr/ASSET-NOTICES.md', 'release/voice-asr/downloads.json',
            *('sdk/plugins/voice-shared-runtime/' + name
              for name in ('assets.json', 'asr.py', 'asr_worker.py', 'worker_protocol.py')),
        )
        for relative in files:
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((repository / relative).read_bytes())

    def test_explicit_local_overlay_accepts_non_r4_version_and_digest(self):
        module = Path(__file__).resolve().parents[1] / 'scripts/package-installer-incremental.py'
        manifest = json.loads(self.manifest.read_text())
        manifest['appVersion'] = self.version
        self.manifest.write_text(json.dumps(manifest))
        sha = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        args = [sys.executable, '-B', str(module), '--source', str(self.source),
                '--base-manifest', str(self.manifest), '--base-manifest-sha256', sha,
                '--build-30', str(self.builds['30fps']), '--build-60', str(self.builds['60fps']),
                '--root', str(self.roots), '--output', str(self.out), '--receipts', str(self.work),
                '--galgame-expressions']
        missing = subprocess.run(args, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn('Pinned local Galgame overlay version does not match', missing.stderr)
        supplied = subprocess.run(args + ['--local-galgame-base-version', self.version], capture_output=True, text=True)
        self.assertNotEqual(supplied.returncode, 0)
        self.assertIn('final manifest filename/version differs', supplied.stderr.lower())
        self.assertNotIn('Pinned local Galgame overlay version does not match', supplied.stderr)
        bad_hash = args.copy()
        bad_hash[bad_hash.index('--base-manifest-sha256') + 1] = '0' * 64
        rejected = subprocess.run(bad_hash + ['--local-galgame-base-version', self.version], capture_output=True, text=True)
        self.assertIn('Pinned base manifest SHA-256 differs', rejected.stderr)
        self.assertFalse(self.out.exists())

    def test_unknown_asset_is_rejected_before_creating_release(self):
        (self.builds['30fps'] / 'assets/unlisted.webp').write_bytes(b'cannot silently disappear')
        with self.assertRaisesRegex(ValueError, 'asset coverage'):
            self.run_package()
        self.assertFalse(self.out.exists())


    def test_release_reuses_original_resource_bytes_and_includes_new_code(self):
        result = self.run_package()
        self.assertEqual((result['totalPackages'], result['reusedPackages'], result['repackedPackages']), (5, 2, 3))
        runtime = self.out / 'AI-Buddy-2.0.7-runtime.zip'
        self.assertTrue(runtime.samefile(self.base / runtime.name))
        manifest = json.loads((self.out / f'install-manifest-{self.version}.json').read_text())
        self.assertEqual(manifest['runtime']['sha256'], hashlib.sha256(b'runtime remains version five').hexdigest())
        for edition in ['30fps', '60fps']:
            with zipfile.ZipFile(self.out / (f'AI-Buddy-{self.version}-app-{edition}.zip')) as archive:
                self.assertEqual(archive.read('new-worker.cjs'), b'new public worker included')
                self.assertEqual(archive.read('main.cjs'), b'new code')
                self.assertEqual(json.loads(archive.read('package.json'))['version'], self.version)
                self.assertNotIn('assets/picture.png', archive.namelist())
        self.assertEqual(result['coverage']['30fps']['buildFiles'], 6)
        self.assertEqual((self.work / 'packaging-result.json').exists(), True)

    def test_corrupt_pinned_resource_zip_is_rejected(self):
        with (self.base / 'AI-Buddy-2.0.7-shared.zip').open('ab') as stream:
            stream.write(b'corrupt published bytes')
        with self.assertRaisesRegex(ValueError, 'SHA-256/size differs'):
            self.run_package()
        self.assertFalse(self.out.exists())


    def run_manifest_portable(self):
        installer = self.root / 'installer.exe'
        installer.write_bytes(b'actual manager fixture bytes')
        manifest = self.out / f'install-manifest-{self.version}.json'
        def inspect(command, **kwargs):
            receipt = Path(next(v[10:] for v in command if v.startswith('--receipt=')))
            receipt.write_text(json.dumps(dict(ok=True, version=self.version, manifestSha256=hashlib.sha256(manifest.read_bytes()).hexdigest(), appUpdateProtocol=1, appBootstrapProtocol=1)))
            return subprocess.CompletedProcess(command, 0, '', '')
        with patch('subprocess.run', side_effect=inspect):
            return portable_packaging.portable_from_manifest(self.root / 'manifest-candidate', self.out, installer, self.root / 'portable-work', source=self.source, builds=self.builds, root_tree=self.roots)

    def test_portable_from_manifest_preserves_runtime_four_with_media_five(self):
        self.run_package()
        result = self.run_manifest_portable()
        self.assertEqual([e['edition'] for e in result['editions']], ['30fps', '60fps'])
        self.assertTrue(result['everyVolumeAtMostOneGiB'])
        for edition in ['30fps', '60fps']:
            tree = self.root / 'portable-work' / edition / 'AI-Buddy'
            runtime = json.loads((tree / f'runtime/AI-Buddy-v{self.version}/runtime-manifest.json').read_text())
            record = json.loads((tree / 'local/portable-defaults.json').read_text())['installation']
            self.assertEqual(runtime['version'], '2.0.4')
            self.assertEqual(record['managerSha256'], hashlib.sha256(b'actual manager fixture bytes').hexdigest())
            self.assertTrue((tree / 'builds' / (f'v{self.version}-{edition}') / 'assets/picture.png').samefile(self.builds[edition] / 'assets/picture.png'))
            with zipfile.ZipFile(self.root / 'portable-work' / (f'AI-Buddy-{self.version}-Windows-x64-{edition}.zip')) as archive:
                self.assertEqual(archive.read(f'AI-Buddy/builds/v{self.version}-{edition}/new-worker.cjs'), b'new public worker included')
        self.assertTrue((self.root / 'portable-work/release-assets-index.json').exists())

    def test_portable_from_manifest_rejects_candidate_bytes_outside_manifest(self):
        self.run_package()
        (self.builds['30fps'] / 'main.cjs').write_bytes(b'changed after final manifest')
        with self.assertRaisesRegex(ValueError, 'candidate files differ'):
            self.run_manifest_portable()
        self.assertFalse((self.root / 'manifest-candidate').exists())
        self.assertFalse((self.root / 'portable-work').exists())

    def test_portable_from_manifest_rejects_real_zip_bytes_outside_manifest(self):
        self.run_package()
        # Replace the hardlink leaf, preserving the published base bytes.
        target = self.out / 'AI-Buddy-2.0.7-shared.zip'
        target.unlink(); target.write_bytes(b'not the manifest ZIP')
        with self.assertRaisesRegex(ValueError, 'Package artifact SHA-256/size differs'):
            self.run_manifest_portable()
        self.assertFalse((self.root / 'manifest-candidate').exists())
        self.assertFalse((self.root / 'portable-work').exists())


if __name__ == '__main__':
    unittest.main()
