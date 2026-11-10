"""Synthetic receipt contracts only; never starts an app, downloads or signs."""
from copy import deepcopy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from installed_plugin_runtime_proof import validate_runtime_proofs

TARGETS = [
    ('bilibili', '@ai-buddy/bilibili-companion', '2.0.16', '9d585ffc887f9a274cb7f321b514fb0b60b400a38665d5563d216f67fdc73336'),
    ('qq', '@ai-buddy/qq-connect', '2.0.10', 'c58110307866f15a309bbb9ad2839e521ea61caf897bc7666e0353f582545a6d'),
    ('card-games', '@ai-buddy/card-games', '1.1.5', '7f2c6dcfff0bd3a2e0ad602fea03c1361490914e4764821b374bdd59f7eb086d'),
]


class RuntimeProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-runtime-proof-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest_path = self.root / 'synthetic-install-manifest.json'
        self.runtime_path = self.root / 'synthetic-runtime-RESULT.json'
        self.update_path = self.root / 'synthetic-update-RESULT.json'
        self.manifest = dict(appVersion='2.0.14', packages=[dict(id='app-30fps', sha256='a' * 64, files=[dict(path='main.cjs', sha256='b' * 64)])])
        self.manifest_path.write_text(json.dumps(self.manifest), encoding='utf-8')
        identity = dict(root='E:/synthetic/installed', build='E:/synthetic/installed/builds/2.0.14', dataRoot='E:/synthetic/installed/local/data', version='2.0.14', processId=12345, installationRecordSha256='c' * 64, manifestSha256=hashlib.sha256(self.manifest_path.read_bytes()).hexdigest(), appPackageSha256='a' * 64, mainSha256='b' * 64, codeDirectorySha256='d' * 64, codeFiles=[dict(path='main.cjs', bytes=4, sha256='b' * 64)])
        self.runtime = dict(schemaVersion=1, kind='installed-plugin-runtime-release-gate', scope='synthetic isolated validation only', fixture='SYNTHETIC RECEIPTS ONLY: no app ever ran', passed=True, expectedVersion='2.0.14', mode='install', identityBefore=identity, identityAfter=deepcopy(identity), rows=[self.row(target) for target in TARGETS])
        self.update = deepcopy(self.runtime)
        self.update['mode'] = 'upgrade-plugin'
        row = self.row(TARGETS[0])
        row['before'] = dict(sourceId='official', packageName=TARGETS[0][1], exactVersion='2.0.15', sourceDigest='e' * 64)
        row['plan']['updateFrom'] = '2.0.15'
        row['update'] = dict(backend='dsh', state='available', fromVersion='unused', **{'from': '2.0.15', 'to': TARGETS[0][2], 'digest': TARGETS[0][3]})
        self.update['rows'] = [row]

    def row(self, target):
        key, name, version, digest = target
        package_key = 'dsh:official:' + name
        def job(phase):
            return dict(id=key + '-' + phase, state='completed')
        def handshake(n):
            return dict(embed=dict(target=key, state='run'), document=dict(targetId=key + '-document-' + str(n), timeOrigin=1000 + n, origin='http://127.0.0.1:49152', readyState='complete', embedded='1', panel=name, openPlugin=name))
        def stop(phase):
            return dict(job=job(phase), embed=[dict(target=key, state='idle')])
        return dict(target=key, packageName=name, version=version, sourceDigest=digest, packageKey=package_key, passed=True, plan=dict(packageKey=package_key, planId='synthetic-plan-' + key, catalogDigest='f' * 64, sourceFingerprint='SHA256:synthetic-catalog-only', packageRef=dict(sourceId='official', packageName=name, exactVersion=version, sourceDigest=digest)), installed=dict(sourceId='official', packageName=name, exactVersion=version, sourceDigest=digest, enabled=True, runtimeVerified=True), artifact=dict(sha256=digest, bytes=4, directory='E:/synthetic/plugin/' + key, packageJsonSha256='0' * 64), install=job('install'), enable=job('enable'), first=handshake(1), stop=stop('stop'), restart=job('restart'), second=handshake(2), finalStop=stop('final-stop'))

    def validate(self):
        self.runtime_path.write_text(json.dumps(self.runtime), encoding='utf-8')
        self.update_path.write_text(json.dumps(self.update), encoding='utf-8')
        return validate_runtime_proofs(self.manifest_path, self.runtime_path, self.update_path)

    def test_synthetic_pair_is_bound_to_actual_manifest_bytes_and_application_files(self):
        result = self.validate()
        self.assertTrue(result['passed'])
        self.assertEqual(result['manifestSha256'], hashlib.sha256(self.manifest_path.read_bytes()).hexdigest())
        self.assertEqual(result['appPackageSha256'], 'a' * 64)
        self.assertEqual(result['mainSha256'], 'b' * 64)
        self.assertEqual(result['runtimeProof']['sha256'], hashlib.sha256(self.runtime_path.read_bytes()).hexdigest())

    def test_qualification_fields_cannot_claim_pass_for_wrong_kind_scope_schema_or_mode(self):
        original = deepcopy(self.runtime)
        for field, value in [('kind', 'services-ready'), ('scope', 'source-test'), ('schemaVersion', True), ('passed', 1), ('mode', 'upgrade-plugin'), ('expectedVersion', '2.0.13')]:
            with self.subTest(field=field):
                self.runtime = dict(deepcopy(original), **{field: value})
                with self.assertRaises(ValueError):
                    self.validate()

    def test_install_proof_requires_each_of_the_three_distinct_official_targets(self):
        self.runtime['rows'][-1] = deepcopy(self.runtime['rows'][0])
        with self.assertRaisesRegex(ValueError, 'three|target|duplicate'):
            self.validate()

    def test_all_real_maintenance_phases_must_have_completed(self):
        original = deepcopy(self.runtime)
        for phase in ('install', 'enable', 'restart', 'stop', 'finalStop'):
            with self.subTest(phase=phase):
                self.runtime = deepcopy(original)
                found = self.runtime['rows'][0][phase]
                (found['job'] if phase in ('stop', 'finalStop') else found)['state'] = 'running'
                with self.assertRaisesRegex(ValueError, 'completed'):
                    self.validate()

    def test_service_flags_or_wrong_document_cannot_replace_both_panel_handshakes(self):
        original = deepcopy(self.runtime)
        for phase in ('first', 'second'):
            with self.subTest(phase=phase):
                self.runtime = deepcopy(original)
                self.runtime['rows'][0][phase] = dict(embed=dict(state='run'), ready=True)
                with self.assertRaisesRegex(ValueError, 'document|handshake'):
                    self.validate()
        self.runtime = deepcopy(original)
        self.runtime['rows'][0]['second']['document']['panel'] = '@other/plugin'
        with self.assertRaisesRegex(ValueError, 'panel|handshake'):
            self.validate()

    def test_restart_must_have_a_fresh_document_and_a_distinct_job(self):
        self.runtime['rows'][0]['second'] = deepcopy(self.runtime['rows'][0]['first'])
        with self.assertRaisesRegex(ValueError, 'fresh|restart'):
            self.validate()

    def test_upgrade_is_one_genuinely_older_package_not_same_version_reinstallation(self):
        row = self.update['rows'][0]
        row['before']['exactVersion'] = row['version']
        row['plan']['updateFrom'] = row['version']
        row['update']['from'] = row['version']
        with self.assertRaisesRegex(ValueError, 'older|same.version'):
            self.validate()

    def test_upgrade_old_version_digest_and_production_update_plan_must_agree(self):
        self.update['rows'][0]['plan']['updateFrom'] = '2.0.14'
        with self.assertRaisesRegex(ValueError, 'update|starting'):
            self.validate()

    def test_stale_manifest_app_package_or_main_hash_cannot_pass_with_same_version(self):
        original = deepcopy(self.runtime)
        for field in ('manifestSha256', 'appPackageSha256', 'mainSha256'):
            with self.subTest(field=field):
                self.runtime = deepcopy(original)
                self.runtime['identityBefore'][field] = self.runtime['identityAfter'][field] = '9' * 64
                with self.assertRaisesRegex(ValueError, 'manifest|package|main'):
                    self.validate()

    def test_changed_before_after_identity_or_undrained_cleanup_is_not_acceptance(self):
        self.runtime['identityAfter']['processId'] += 1
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.validate()
        self.runtime['identityAfter'] = deepcopy(self.runtime['identityBefore'])
        self.update['failureCleanupNeedsDrain'] = True
        with self.assertRaisesRegex(ValueError, 'cleanup'):
            self.validate()

    def test_manifest_requires_exactly_one_30fps_package_and_main_entry(self):
        self.manifest['packages'][0]['files'] = []
        self.manifest_path.write_text(json.dumps(self.manifest), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'main.cjs'):
            self.validate()

    def test_cli_requires_both_proofs_without_touching_candidate_or_artifacts(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/preflight-installer-release.py'
        args = [sys.executable, '-B', str(script), '--source', 'a' * 40, '--manifest', str(self.manifest_path), '--installer', str(self.root / 'absent-installer.exe'), '--checksums', str(self.root / 'absent-checksums.txt'), '--output', str(self.root / 'preflight')]
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--runtime-proof', result.stderr)
        self.assertIn('--plugin-update-proof', result.stderr)
        self.assertFalse((self.root / 'preflight').exists())

    def test_wrapper_combines_runtime_only_after_real_small_zip_checks_and_rejects_tampering(self):
        # Reuse the existing small synthetic release fixture. Only external Git
        # and installer OS processes are substituted, never artifact validation.
        from installer_release_r4_test import InstallerInputTests
        fixture = InstallerInputTests('test_preflight_prepares_all_six_bindings_without_signing')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.packages[:] = [row for row in fixture.packages if not row['id'].startswith('app-')]
        for edition in ('30fps', '60fps'):
            fixture.add_package('app-' + edition, 'build', {'package.json': json.dumps(dict(version='2.0.7', animationProfile=edition)).encode(), 'main.cjs': b'synthetic contract main'}, edition=edition)
        fixture.save_manifest()
        fixture.release_inputs()
        self.manifest_path = fixture.manifest
        app = next(row for row in fixture.packages if row['id'] == 'app-30fps')
        main_sha = next(row['sha256'] for row in app['files'] if row['path'] == 'main.cjs')
        for proof in (self.runtime, self.update):
            proof['expectedVersion'] = '2.0.7'
            for name in ('identityBefore', 'identityAfter'):
                proof[name].update(version='2.0.7', manifestSha256=hashlib.sha256(fixture.manifest.read_bytes()).hexdigest(), appPackageSha256=app['sha256'], mainSha256=main_sha, codeFiles=[dict(path='main.cjs', bytes=23, sha256=main_sha)])
        self.validate()
        path = Path(__file__).resolve().parents[1] / 'scripts/preflight-installer-release.py'
        spec = importlib.util.spec_from_file_location('synthetic_preflight_wrapper', path)
        wrapper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(wrapper)
        inspections = []

        def external(command, **kwargs):
            if command[:3] == ['git', 'rev-parse', 'HEAD']:
                return subprocess.CompletedProcess(command, 0, 'a' * 40 + '\n', '')
            if command[:2] == ['git', 'status']:
                return subprocess.CompletedProcess(command, 0, '', '')
            receipt = Path(next(part.removeprefix('--receipt=') for part in command if part.startswith('--receipt=')))
            inspections.append(command)
            receipt.write_text(json.dumps(dict(ok=True, version='2.0.7', manifestSha256=hashlib.sha256(fixture.manifest.read_bytes()).hexdigest(), appUpdateProtocol=1, appBootstrapProtocol=1)), encoding='utf-8')
            return subprocess.CompletedProcess(command, 0, '', '')

        output = fixture.root / 'combined-preflight'
        argv = [str(path), '--source-root', str(fixture.source), '--source', 'a' * 40, '--manifest', str(fixture.manifest), '--installer', str(fixture.installer), '--checksums', str(fixture.checksums), '--runtime-proof', str(self.runtime_path), '--plugin-update-proof', str(self.update_path), '--output', str(output)]
        with patch('subprocess.run', side_effect=external), patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
            wrapper.main()
        result = json.loads((output / 'release-preflight.json').read_text(encoding='utf-8'))
        self.assertTrue(result['ok'] and result['runtimeGate']['passed'])
        self.assertEqual(len(inspections), 1)
        artifact = json.loads((output / 'artifact-only/release-preflight.json').read_text(encoding='utf-8'))
        self.assertFalse(artifact['ok'])
        self.assertTrue(artifact['artifactChecksPassed'])
        self.assertEqual(artifact['kind'], 'artifact-only-not-release-qualified')
        (fixture.release / app['assetName']).write_bytes(b'tampered real ZIP bytes')
        broken_output = fixture.root / 'tampered-preflight'
        argv[-1] = str(broken_output)
        with patch('subprocess.run', side_effect=external), patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
            with self.assertRaises(ValueError):
                wrapper.main()
        self.assertFalse((broken_output / 'release-preflight.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
