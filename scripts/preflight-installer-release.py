"""Verify release artifacts and prepare unsigned tag text; never sign, push or publish."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True

from installer_release_inputs import release_preflight, source_version
from installed_plugin_runtime_proof import validate_runtime_proofs
from public_distribution_validation import OwnedOutput, boundaries, require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--source', required=True, help='Full source commit SHA; must match the clean checkout HEAD')
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--installer', type=Path, required=True, help='Actual final installer beside the manifest')
    parser.add_argument('--checksums', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Fresh disjoint preflight evidence directory')
    parser.add_argument('--runtime-proof', type=Path, required=True, help='Installed candidate driver RESULT.json: three official plugins and stop/restart document handshakes')
    parser.add_argument('--plugin-update-proof', type=Path, required=True, help='Driver RESULT.json: upgrade-plugin from a genuinely older official package')
    parser.add_argument('--tag-message', type=Path, help='Optional proposed annotated tag message to validate')
    args = parser.parse_args()
    source_root = args.source_root.absolute()
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=source_root, capture_output=True, text=True, check=True).stdout.strip()
    if head != args.source:
        parser.error('--source differs from the current checkout HEAD')
    # Include every source root file copied by build-distribution-202.mjs.
    root_files = ['AI Buddy.cmd', 'AI Buddy.vbs', 'Start-AI-Buddy.ps1', 'LICENSE.md', 'README.md', 'README.en.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_MONITOR.md', 'CG_API_GUIDE.md']
    status = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=normal', '--', 'src', 'installer', 'scripts', 'test', 'docs', 'assets', 'licenses', 'release', 'package.json', 'package-lock.json', 'release.json', *root_files], cwd=source_root, capture_output=True, text=True, check=True).stdout
    if status.strip():
        parser.error('Release source has uncommitted changes; commit the final reviewed source before release preflight')
    message = args.tag_message.read_text(encoding='utf-8') if args.tag_message else None
    source_version(source_root)
    # Reject missing/stale runtime evidence before expensive artifact work. This
    # validator never substitutes for the existing ZIP/payload/inspect checks.
    runtime_gate = validate_runtime_proofs(args.manifest, args.runtime_proof, args.plugin_update_proof)
    target = args.output.absolute()
    boundaries(inputs=(source_root, args.manifest.absolute().parent, args.runtime_proof.absolute(), args.plugin_update_proof.absolute()), outputs=(target,), fresh=(target,))
    output = OwnedOutput(target, fresh=True)
    output.directory(target, fresh=True)
    result = release_preflight(source_root, args.manifest.absolute(), args.installer.absolute(), args.checksums.absolute(), args.source, target / 'artifact-only', message)
    # Preserve the complete original artifact check as explicitly unqualified.
    # Only the outer receipt and tag draft are the combined release preflight.
    artifact = dict(result, kind='artifact-only-not-release-qualified', ok=False, artifactChecksPassed=True, runtimeGateRequired=True)
    output.write_text(target / 'artifact-only' / 'release-preflight.json', json.dumps(artifact, indent=2) + '\n', replace=True)
    rechecked = validate_runtime_proofs(args.manifest, args.runtime_proof, args.plugin_update_proof)
    require(rechecked == runtime_gate and result['manifestSha256'] == runtime_gate['manifestSha256'] and result['version'] == runtime_gate['version'], 'Runtime proof/manifest identity changed during artifact preflight')
    draft = target / ('unsigned-tag-v' + result['version'] + '.txt')
    output.write_text(draft, Path(result['unsignedTagMessage']).read_text(encoding='utf-8'), replace=False)
    result = dict(result, kind='runtime-qualified-installer-release-preflight', runtimeGate=runtime_gate, unsignedTagMessage=str(draft))
    output.write_text(target / 'release-preflight.json', json.dumps(result, indent=2) + '\n', replace=False)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
