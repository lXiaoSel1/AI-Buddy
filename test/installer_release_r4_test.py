"""Targeted artifact-boundary tests; no media, network, install or signing."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from installer_release_inputs import inspect_installer


class InstallerIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='buddy-release-r4-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.probe_count = 0
        self.installer = self.root / 'installer.exe'
        self.installer.write_bytes(b'real manager bytes for hashing')
        self.manifest = self.root / 'install-manifest-2.0.7.json'
        self.manifest.write_text('{"appVersion":"2.0.7"}', encoding='utf-8')
        self.identity = dict(ok=True, version='2.0.7', manifestSha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest(), appUpdateProtocol=1, appBootstrapProtocol=1)

    def run_inspect(self, identity):
        # Only the OS process boundary is substituted; validation/hash/file IO run.
        def process(command, **kwargs):
            receipt = Path(next(p.removeprefix('--receipt=') for p in command if p.startswith('--receipt=')))
            receipt.write_text(json.dumps(identity), encoding='utf-8-sig')
            return subprocess.CompletedProcess(command, 0, '', '')
        with patch('subprocess.run', side_effect=process):
            self.probe_count += 1
            return inspect_installer(self.installer, self.manifest, self.root / ('probe-' + str(self.probe_count)), '2.0.7')

    def test_manager_registration_uses_actual_executable_digest(self):
        result = self.run_inspect(self.identity)
        self.assertEqual(result['managerProtocol'], 1)
        self.assertEqual(result['managerSha256'], 'a5c46c50ae384c146348d835c530ee176ef664b2db19004050741298d7879a6f')

    def test_old_inspect_receipt_cannot_register_capability(self):
        old = {k: v for k, v in self.identity.items() if k not in ('appUpdateProtocol', 'appBootstrapProtocol')}
        with self.assertRaisesRegex(ValueError, 'protocol'):
            self.run_inspect(old)

    def test_mismatched_version_or_manifest_cannot_register_manager(self):
        for mutation in ({'version': '2.0.6'}, {'manifestSha256': '0' * 64}, {'appUpdateProtocol': True}, {'appBootstrapProtocol': 0}):
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):
                    self.run_inspect(dict(self.identity, **mutation))


class ReleaseSourceCliTests(unittest.TestCase):
    def test_modified_distribution_launcher_with_unchanged_head_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='buddy-source-gate-r4-') as directory:
            root = Path(directory)
            repo = root / 'source'; repo.mkdir()
            launcher = repo / 'AI Buddy.cmd'
            launcher.write_text('@echo off\r\necho original\r\n', encoding='utf-8')
            git_options = ['git', '-c', 'core.hooksPath=' + str(root / 'no-hooks'), '-c', 'commit.gpgsign=false', '-c', 'user.name=Packaging fixture', '-c', 'user.email=fixture@example.invalid']
            def git(*args):
                return subprocess.run(git_options + list(args), cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            git('init', '--quiet')
            git('add', '--', launcher.name)
            git('commit', '--quiet', '-m', 'Fixture launcher baseline')
            head = git('rev-parse', 'HEAD')
            script = Path(__file__).resolve().parents[1] / 'scripts/preflight-installer-release.py'
            command = [sys.executable, '-B', str(script), '--source-root', str(repo), '--source', head, '--manifest', str(root / 'release/install-manifest-2.0.7.json'), '--installer', str(root / 'release/AI-Buddy-Setup-2.0.7-win-x64.exe'), '--checksums', str(root / 'release/SHA256SUMS-2.0.7.txt'), '--output', str(root / 'preflight')]
            clean = subprocess.run(command, capture_output=True, text=True)
            self.assertNotIn('uncommitted changes', clean.stderr)
            self.assertIn('package.json', clean.stderr)  # Clean source reaches artifact validation.
            launcher.write_text('@echo off\r\necho modified after source commit\r\n', encoding='utf-8')
            self.assertEqual(git('rev-parse', 'HEAD'), head)
            rejected = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 2)
            self.assertIn('Release source has uncommitted changes', rejected.stderr)
            self.assertFalse((root / 'preflight').exists())


class InstallerInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='buddy-inputs-r4-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.release = self.root / 'source', self.root / 'release'
        self.source.mkdir(); self.release.mkdir()
        for name, body in {
            'package.json': '{"version":"2.0.7"}',
            'package-lock.json': '{"version":"2.0.7","packages":{"":{"version":"2.0.7"}}}',
            'installer/AI.Buddy.Setup.csproj': '<Project><PropertyGroup><Version>2.0.7</Version><AssemblyName>AI-Buddy-Setup-2.0.7-win-x64</AssemblyName></PropertyGroup></Project>',
            'installer/Core/ReleaseIdentity.cs': 'public const string Version="2.0.7";',
            'installer/Program.cs': '// small source fixture',
            'installer/global.json': '{"sdk":{"version":"10.0.402"}}',
            'installer/packages.lock.json': '{}',
            'installer/app.manifest': '<assembly/>',
            'assets/branding/app.ico': 'icon',
            'licenses/DOTNET-LICENSE.txt': 'license',
        }.items():
            target = self.source / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(body, encoding='utf-8')
        self.packages = []
        runtime_files = [dict(path='AI Buddy.exe', bytes=7, sha256=hashlib.sha256(b'runtime').hexdigest())]
        self.add_package('runtime', 'runtime', {'AI Buddy.exe': b'runtime', 'runtime-manifest.json': json.dumps(dict(version='2.0.7', files=runtime_files)).encode()})
        self.add_package('root', 'root', {'README.md': b'AI Buddy'})
        self.add_package('character-deepseek', 'build', {'assets/deepseek.webp': b'character'})
        for edition in ('30fps', '60fps'):
            self.add_package('app-' + edition, 'build', {'package.json': json.dumps(dict(version='2.0.7', animationProfile=edition)).encode()}, edition=edition)
        self.manifest = self.release / 'install-manifest-2.0.7.json'
        self.value = dict(schemaVersion=1, appVersion='2.0.7', releaseTag='v2.0.7', repository='lXiaoSel1/AI-Buddy', platform='win32', arch='x64', minimumInstallerVersion='2.0.7', resourceContractVersion=1, defaultEdition='30fps', defaultCharacterId='deepseek', requiredPackageIds=['root', 'runtime'], runtime=dict(executable='AI Buddy.exe', sha256=hashlib.sha256(b'runtime').hexdigest()), editions=[dict(id=e, label=e, appPackageId='app-' + e) for e in ('30fps', '60fps')], characters=[dict(id='deepseek', name='DeepSeek', commonPackageId='character-deepseek', motions={'30fps': [], '60fps': []})], packages=self.packages)
        self.save_manifest()

    def add_package(self, identifier, mount, payloads, **extra):
        asset = 'AI-Buddy-2.0.7-' + identifier + '.zip'
        rows = []
        with zipfile.ZipFile(self.release / asset, 'w') as archive:
            for name, payload in payloads.items():
                archive.writestr(name, payload)
                rows.append(dict(path=name, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
        raw = (self.release / asset).read_bytes()
        index = ''.join(f"{f['path']}\t{f['bytes']}\t{f['sha256']}\n" for f in rows).encode()
        self.packages.append(dict(id=identifier, kind=identifier.split('-')[0], mount=mount, assetName=asset, bytes=len(raw), unpackedBytes=sum(f['bytes'] for f in rows), sha256=hashlib.sha256(raw).hexdigest(), filesSha256=hashlib.sha256(index).hexdigest(), files=rows, dependsOn=[], **extra))

    def save_manifest(self):
        self.manifest.write_text(json.dumps(self.value), encoding='utf-8')

    def set_old_runtime(self, *, declared_version=None, old_asset_name=False, bad_file_index=False, actual_version="2.0.5", runtime_declared_version=None):
        self.packages[:] = [p for p in self.packages if p['id'] != 'runtime']
        files = [dict(path='AI Buddy.exe', bytes=7, sha256='0' * 64 if bad_file_index else hashlib.sha256(b'runtime').hexdigest())]
        self.add_package('runtime', 'runtime', {'AI Buddy.exe': b'runtime', 'runtime-manifest.json': json.dumps(dict(version=actual_version, files=files)).encode()})
        if old_asset_name:
            runtime = self.packages[-1]
            original = self.release / runtime['assetName']
            runtime['assetName'] = 'AI-Buddy-2.0.5-runtime.zip'
            original.rename(self.release / runtime['assetName'])
        if declared_version:
            (self.source / 'release.json').write_text(json.dumps(dict(schemaVersion=1, version='2.0.7', resourceBaseVersion=declared_version)), encoding='utf-8')
        if runtime_declared_version is not None:
            state = json.loads((self.source / 'release.json').read_text())
            state['runtimeBaseVersion'] = runtime_declared_version
            (self.source / 'release.json').write_text(json.dumps(state))
        self.save_manifest()

    def test_prepare_stages_exact_final_manifest_and_hash_outside_source(self):
        from installer_release_inputs import prepare_installer_inputs
        result = prepare_installer_inputs(self.source, self.manifest, self.root / 'build')
        generated = Path(result['project']).parent / 'generated/install-manifest.json'
        self.assertEqual(generated.read_bytes(), self.manifest.read_bytes())
        self.assertFalse((self.source / 'installer/generated').exists())
        self.assertIn(hashlib.sha256(self.manifest.read_bytes()).hexdigest(), (generated.parent.parent / 'BuildIdentity.g.cs').read_text())

    def test_prepare_rejects_mixed_source_version_before_creating_build(self):
        from installer_release_inputs import prepare_installer_inputs
        (self.source / 'installer/Core/ReleaseIdentity.cs').write_text('public const string Version="2.0.6";')
        with self.assertRaisesRegex(ValueError, 'version'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'build')
        self.assertFalse((self.root / 'build').exists())

    def test_prepare_rejects_manifest_version_and_actual_package_tampering(self):
        from installer_release_inputs import prepare_installer_inputs
        self.value['appVersion'] = '2.0.6'; self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Manifest version'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'bad-version')
        self.value['appVersion'] = '2.0.7'; self.save_manifest()
        (self.release / self.packages[0]['assetName']).write_bytes(b'changed package')
        with self.assertRaisesRegex(ValueError, 'Package artifact'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'bad-package')
        self.assertFalse((self.root / 'bad-version').exists())
        self.assertFalse((self.root / 'bad-package').exists())

    def test_prepare_rejects_rehashed_application_package_with_old_embedded_version(self):
        from installer_release_inputs import prepare_installer_inputs
        self.packages[:] = [p for p in self.packages if p['id'] != 'app-30fps']
        self.add_package('app-30fps', 'build', {'package.json': b'{"version":"2.0.6","animationProfile":"30fps"}'}, edition='30fps')
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Packaged application version'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'bad-code')

    def release_inputs(self):
        self.installer = self.release / 'AI-Buddy-Setup-2.0.7-win-x64.exe'
        self.installer.write_bytes(b'inspected release manager')
        self.checksums = self.release / 'SHA256SUMS-2.0.7.txt'
        files = sorted([p['assetName'] for p in self.packages] + [self.manifest.name, self.installer.name])
        self.checksums.write_text(''.join(hashlib.sha256((self.release / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in files), encoding='utf-8')

    def preflight(self, message=None):
        from installer_release_inputs import release_preflight
        def inspect(command, **kwargs):
            receipt = Path(next(p[10:] for p in command if p.startswith('--receipt=')))
            receipt.write_text(json.dumps(dict(ok=True, version='2.0.7', manifestSha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest(), appUpdateProtocol=1, appBootstrapProtocol=1)))
            return subprocess.CompletedProcess(command, 0, '', '')
        with patch('subprocess.run', side_effect=inspect):
            return release_preflight(self.source, self.manifest, self.installer, self.checksums, 'a' * 40, self.root / 'preflight', message)

    def test_preflight_prepares_all_six_bindings_without_signing(self):
        self.release_inputs()
        result = self.preflight()
        text = Path(result['unsignedTagMessage']).read_text()
        bindings = dict(line.split(': ', 1) for line in text.splitlines() if ': ' in line)
        self.assertEqual(set(bindings), {'Source', 'Installer SHA-256', 'Manifest SHA-256', 'Checksums SHA-256', 'App Update Protocol', 'App Bootstrap Protocol'})
        self.assertEqual(bindings['Source'], 'a' * 40)
        self.assertEqual(bindings['App Update Protocol'], '1')
        self.assertEqual(bindings['App Bootstrap Protocol'], '1')
        self.assertEqual(bindings['Checksums SHA-256'], hashlib.sha256(self.checksums.read_bytes()).hexdigest())
        self.assertFalse(result['signingPerformed'])

    def test_preflight_rejects_incomplete_checksums_and_bad_proposed_tag(self):
        self.release_inputs()
        sums = self.checksums.read_text()
        self.checksums.write_text('\n'.join(sums.splitlines()[1:]) + '\n')
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.preflight()
        self.checksums.write_text(sums)
        with self.assertRaisesRegex(ValueError, 'tag'):
            self.preflight('Source: ' + 'a' * 40 + '\nApp Update Protocol: 1\n')
        self.assertFalse((self.root / 'preflight/unsigned-tag-v2.0.7.txt').exists())

    def test_explicit_resource_base_allows_old_runtime_and_manifest_named_old_assets(self):
        from installer_release_inputs import prepare_installer_inputs
        self.set_old_runtime(declared_version='2.0.5', old_asset_name=True)
        character = next(p for p in self.packages if p['id'] == 'character-deepseek')
        original = self.release / character['assetName']
        character['assetName'] = 'AI-Buddy-2.0.5-character-deepseek.zip'
        original.rename(self.release / character['assetName'])
        self.save_manifest()
        prepared = prepare_installer_inputs(self.source, self.manifest, self.root / 'build')
        self.assertEqual(prepared['version'], '2.0.7')
        self.release_inputs()
        result = self.preflight()
        self.assertTrue(result['ok'])
        self.assertIn('AI-Buddy-2.0.5-runtime.zip', {row['file'] for row in result['artifacts']})
        self.assertIn('AI-Buddy-2.0.5-character-deepseek.zip', {row['file'] for row in result['artifacts']})

    def test_declared_media_five_and_runtime_four_are_independent(self):
        from installer_release_inputs import prepare_installer_inputs
        self.set_old_runtime(declared_version='2.0.5', actual_version='2.0.4', runtime_declared_version='2.0.4', old_asset_name=True)
        prepared = prepare_installer_inputs(self.source, self.manifest, self.root / 'build')
        self.assertEqual(prepared['resourceBaseVersion'], '2.0.5')
        self.assertEqual(prepared['runtimeBaseVersion'], '2.0.4')
        self.release_inputs()
        result = self.preflight()
        self.assertEqual(result['resourceBaseVersion'], '2.0.5')
        self.assertEqual(result['runtimeBaseVersion'], '2.0.4')

    def test_explicit_runtime_base_must_match_real_runtime(self):
        from installer_release_inputs import prepare_installer_inputs
        self.set_old_runtime(declared_version='2.0.5', actual_version='2.0.4', runtime_declared_version='2.0.6')
        with self.assertRaisesRegex(ValueError, 'Packaged runtime version'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'wrong-runtime')
        self.assertFalse((self.root / 'wrong-runtime').exists())

    def test_old_runtime_requires_matching_explicit_resource_base(self):
        from installer_release_inputs import prepare_installer_inputs
        self.set_old_runtime()
        with self.assertRaisesRegex(ValueError, 'Packaged runtime version'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'undeclared')
        self.set_old_runtime(declared_version='2.0.6')
        with self.assertRaisesRegex(ValueError, 'Packaged runtime version'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'different-base')
        self.assertFalse((self.root / 'undeclared').exists())
        self.assertFalse((self.root / 'different-base').exists())

    def test_compatible_runtime_still_requires_its_real_file_inventory(self):
        from installer_release_inputs import prepare_installer_inputs
        self.set_old_runtime(declared_version='2.0.5', bad_file_index=True)
        with self.assertRaisesRegex(ValueError, 'runtime file inventory'):
            prepare_installer_inputs(self.source, self.manifest, self.root / 'bad-runtime-files')

    def test_old_extra_attachment_not_declared_by_manifest_is_rejected(self):
        self.release_inputs()
        extra = self.release / 'AI-Buddy-2.0.5-unrelated.txt'
        extra.write_bytes(b'unrelated old attachment')
        with self.checksums.open('a', encoding='utf-8') as stream:
            stream.write(hashlib.sha256(extra.read_bytes()).hexdigest() + '  ' + extra.name + '\n')
        with self.assertRaisesRegex(ValueError, 'another release'):
            self.preflight()


if __name__ == '__main__':
    unittest.main(verbosity=2)
