"""Prepare exact final installer inputs; optionally build and inspect without installing."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True

from installer_release_inputs import inspect_installer, prepare_installer_inputs
from public_distribution_validation import OwnedOutput


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--manifest', type=Path, required=True, help='Final install-manifest-VERSION.json beside its real packages')
    parser.add_argument('--output', type=Path, required=True, help='Fresh disjoint build directory outside source and release assets')
    parser.add_argument('--build', action='store_true', help='Run pinned dotnet publish and inspect the actual self-contained executable')
    args = parser.parse_args()
    result = prepare_installer_inputs(args.source.absolute(), args.manifest.absolute(), args.output.absolute())
    if args.build:
        subprocess.run(result['command'], cwd=Path(result['project']).parent, check=True)
        identity = inspect_installer(Path(result['installer']), args.manifest.absolute(), args.output.absolute() / 'inspect', result['version'])
        result['buildVerified'] = True
        result['installerSha256'] = identity['managerSha256']
        result['inspect'] = identity['identity']
        OwnedOutput(args.output.absolute()).write_text(args.output.absolute() / 'installer-build.json', json.dumps(result, indent=2) + '\n', replace=False)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
