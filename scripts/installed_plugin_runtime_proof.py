"""Bind installed-plugin driver receipts to final manifest bytes; never run an app."""
import hashlib
import json
import math
from pathlib import Path
import re

from public_distribution_validation import no_links, require

KIND = 'installed-plugin-runtime-release-gate'
SCOPE = 'synthetic isolated validation only'
TARGETS = {
    'bilibili': ('@ai-buddy/bilibili-companion', '2.0.16', '9d585ffc887f9a274cb7f321b514fb0b60b400a38665d5563d216f67fdc73336'),
    'qq': ('@ai-buddy/qq-connect', '2.0.10', 'c58110307866f15a309bbb9ad2839e521ea61caf897bc7666e0353f582545a6d'),
    'card-games': ('@ai-buddy/card-games', '1.1.5', '7f2c6dcfff0bd3a2e0ad602fea03c1361490914e4764821b374bdd59f7eb086d'),
}


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def text(value):
    return isinstance(value, str) and bool(value)


def version(value):
    require(isinstance(value, str) and re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value), 'Invalid stable plugin version')
    return tuple(map(int, value.split('.')))


def read_record(path):
    path = no_links(Path(path).absolute())
    require(path.is_file() and path.stat().st_size <= 16 * 1024 * 1024, 'Runtime proof input must be a bounded regular file')
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'Runtime proof input changed while reading')

    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate runtime proof JSON key: ' + key)
            value[key] = item
        return value

    def invalid_constant(value):
        raise ValueError('Non-finite runtime proof JSON constant: ' + value)

    value = json.loads(data.decode('utf-8-sig'), object_pairs_hook=unique, parse_constant=invalid_constant)
    require(isinstance(value, dict), 'Runtime proof/manifest must be a JSON object')
    return value, dict(path=str(path), sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))


def completed(job, phase):
    require(isinstance(job, dict) and text(job.get('id')) and job.get('state') == 'completed', phase + ' job must be completed')


def handshake(value, target, name):
    require(isinstance(value, dict) and isinstance(value.get('document'), dict), 'Actual plugin document handshake is missing')
    embed, document = value.get('embed'), value['document']
    require(isinstance(embed, dict) and embed.get('target') == target and embed.get('state') == 'run', 'Requested plugin embed handshake is missing')
    require(text(document.get('targetId')) and type(document.get('timeOrigin')) in (int, float) and math.isfinite(document['timeOrigin']), 'Actual plugin document identity is missing')
    require(isinstance(document.get('origin'), str) and re.fullmatch(r'http://127\.0\.0\.1:[0-9]+', document['origin']) and document.get('readyState') == 'complete', 'Plugin document readiness/origin differs')
    require(document.get('embedded') == '1' and document.get('panel') == name and document.get('openPlugin') == name, 'Requested plugin panel document handshake differs')
    return document['targetId'], document['timeOrigin']


def stopped(value, target, phase):
    require(isinstance(value, dict), phase + ' proof is missing')
    completed(value.get('job'), phase)
    states = value.get('embed')
    require(isinstance(states, list) and any(isinstance(state, dict) and state.get('target') == target and state.get('state') == 'idle' for state in states), phase + ' plugin page must be idle')
    require(not any(isinstance(state, dict) and state.get('target') == target and state.get('state') in ('run', 'start') for state in states), phase + ' plugin page is still active')


def validate_row(row, upgrade=False):
    require(isinstance(row, dict) and row.get('target') in TARGETS, 'Unknown official plugin target')
    target = row['target']
    name, expected_version, expected_digest = TARGETS[target]
    key = 'dsh:official:' + name
    require(row.get('passed') is True, 'Plugin row did not pass')
    require((row.get('packageName'), row.get('version'), row.get('sourceDigest'), row.get('packageKey')) == (name, expected_version, expected_digest, key), 'Official plugin row package identity differs')
    plan, installed, artifact = row.get('plan'), row.get('installed'), row.get('artifact')
    require(isinstance(plan, dict) and isinstance(plan.get('packageRef'), dict), 'Production plugin plan is missing')
    ref = plan['packageRef']
    require((ref.get('sourceId'), ref.get('packageName'), ref.get('exactVersion'), ref.get('sourceDigest')) == ('official', name, expected_version, expected_digest) and plan.get('packageKey') == key, 'Production plan package identity differs')
    require(text(plan.get('planId')) and text(plan.get('sourceFingerprint')) and digest(plan.get('catalogDigest')), 'Production catalog/plan identity is missing')
    require(isinstance(installed, dict) and (installed.get('packageName'), installed.get('exactVersion'), installed.get('sourceDigest')) == (name, expected_version, expected_digest) and installed.get('enabled') is True and installed.get('runtimeVerified') is True, 'Installed native plugin identity/readiness differs')
    require(isinstance(artifact, dict) and artifact.get('sha256') == expected_digest and type(artifact.get('bytes')) is int and artifact['bytes'] > 0 and text(artifact.get('directory')) and digest(artifact.get('packageJsonSha256')), 'Actual plugin archive/directory hash evidence is missing')
    for phase in ('install', 'enable', 'restart'):
        completed(row.get(phase), phase)
    require(row['enable']['id'] != row['restart']['id'], 'Restart must have a distinct maintenance job')
    first = handshake(row.get('first'), target, name)
    stopped(row.get('stop'), target, 'stop')
    second = handshake(row.get('second'), target, name)
    require(first != second, 'Restart must have a fresh document identity')
    stopped(row.get('finalStop'), target, 'final stop')
    if upgrade:
        before, update = row.get('before'), row.get('update')
        require(isinstance(before, dict) and before.get('sourceId') == 'official' and before.get('packageName') == name, 'Official starting plugin identity is missing')
        require(version(before.get('exactVersion')) < version(expected_version), 'Plugin update requires a genuinely older from version, not a same-version reinstall')
        require(digest(before.get('sourceDigest')) and before['sourceDigest'] != expected_digest, 'Starting plugin digest is missing or equals target')
        require(plan.get('updateFrom') == before['exactVersion'], 'Production update plan differs from starting plugin')
        require(isinstance(update, dict) and update.get('backend') == 'dsh' and update.get('state') == 'available' and (update.get('from'), update.get('to'), update.get('digest')) == (before['exactVersion'], expected_version, expected_digest), 'Pinned production update identity differs')
    return dict(target=target, packageName=name, version=expected_version, sourceDigest=expected_digest, firstDocument=first, secondDocument=second, **({'fromVersion': row['before']['exactVersion'], 'fromDigest': row['before']['sourceDigest']} if upgrade else {}))


def validate_proof(proof, mode, expected_version, manifest_sha, package_sha, main_sha):
    require(type(proof.get('schemaVersion')) is int and proof['schemaVersion'] == 1 and proof.get('kind') == KIND and proof.get('scope') == SCOPE and proof.get('passed') is True and proof.get('mode') == mode, 'Runtime proof kind/scope/schema/passed/mode is invalid')
    require(proof.get('expectedVersion') == expected_version, 'Runtime proof expectedVersion differs from manifest appVersion')
    require(proof.get('failureCleanupNeedsDrain', False) is False and not proof.get('failureCleanup') and not proof.get('cleanupError') and not proof.get('error'), 'Runtime proof has failed or undrained cleanup')
    before, after = proof.get('identityBefore'), proof.get('identityAfter')
    require(isinstance(before, dict) and before and before == after, 'Runtime identityBefore/identityAfter changed or are missing')
    require(all(text(before.get(key)) for key in ('root', 'build', 'dataRoot')) and type(before.get('processId')) is int and before['processId'] > 0, 'Runtime installation/process identity is missing')
    require(before.get('version') == expected_version, 'Runtime identity version differs from manifest')
    require(before.get('manifestSha256') == manifest_sha, 'Runtime manifest SHA-256 differs from actual final manifest bytes')
    require(before.get('appPackageSha256') == package_sha, 'Runtime app package SHA-256 differs from manifest app-30fps')
    require(before.get('mainSha256') == main_sha, 'Runtime main.cjs SHA-256 differs from manifest app-30fps files')
    require(digest(before.get('codeDirectorySha256')) and digest(before.get('installationRecordSha256')), 'Runtime directory/installation record hash is missing')
    code_files = before.get('codeFiles')
    require(isinstance(code_files, list) and [row.get('sha256') for row in code_files if isinstance(row, dict) and row.get('path') == 'main.cjs'] == [main_sha], 'Runtime code inventory main.cjs identity differs')
    rows = proof.get('rows')
    require(isinstance(rows, list), 'Runtime plugin target list is missing')
    if mode == 'install':
        require(len(rows) == 3 and {row.get('target') for row in rows if isinstance(row, dict)} == set(TARGETS), 'Install proof requires three distinct official targets')
    else:
        require(len(rows) == 1, 'Plugin update proof requires exactly one target')
    return [validate_row(row, upgrade=mode == 'upgrade-plugin') for row in rows]


def validate_runtime_proofs(manifest_path, runtime_proof_path, plugin_update_proof_path):
    """Validate recorded results only. Existing artifact/ZIP/inspect checks remain mandatory."""
    manifest, manifest_input = read_record(manifest_path)
    expected_version = manifest.get('appVersion')
    version(expected_version)
    packages = manifest.get('packages')
    require(isinstance(packages, list), 'Final manifest packages are missing')
    apps = [row for row in packages if isinstance(row, dict) and row.get('id') == 'app-30fps']
    require(len(apps) == 1 and digest(apps[0].get('sha256')), 'Final manifest requires exactly one app-30fps package SHA-256')
    files = apps[0].get('files')
    require(isinstance(files, list), 'Final app-30fps file inventory is missing')
    mains = [row for row in files if isinstance(row, dict) and row.get('path') == 'main.cjs']
    require(len(mains) == 1 and digest(mains[0].get('sha256')), 'Final manifest requires exactly one main.cjs file SHA-256')
    runtime, runtime_input = read_record(runtime_proof_path)
    update, update_input = read_record(plugin_update_proof_path)
    package_sha, main_sha = apps[0]['sha256'], mains[0]['sha256']
    runtime_rows = validate_proof(runtime, 'install', expected_version, manifest_input['sha256'], package_sha, main_sha)
    update_rows = validate_proof(update, 'upgrade-plugin', expected_version, manifest_input['sha256'], package_sha, main_sha)
    return dict(schemaVersion=1, kind='installed-plugin-runtime-manifest-bindings', passed=True, version=expected_version, manifestSha256=manifest_input['sha256'], appPackageSha256=package_sha, mainSha256=main_sha, runtimeProof=dict(**runtime_input, mode='install', rows=runtime_rows), pluginUpdateProof=dict(**update_input, mode='upgrade-plugin', rows=update_rows), verifierStartsApplication=False)
