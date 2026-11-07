"""Verify release artifacts and prepare unsigned tag text; never sign, push or publish."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True

from installer_release_inputs import release_preflight


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--source', required=True, help='Full source commit SHA; must match the clean checkout HEAD')
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--installer', type=Path, required=True, help='Actual final installer beside the manifest')
    parser.add_argument('--checksums', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Fresh disjoint preflight evidence directory')
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
    result = release_preflight(source_root, args.manifest.absolute(), args.installer.absolute(), args.checksums.absolute(), args.source, args.output.absolute(), message)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
