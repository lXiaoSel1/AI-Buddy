"""Prepare an explicit, local Windows voice-component seed from pinned inputs.

No files are installed or downloaded by this script. The host verifies and
copies the seed in its own prepare transaction before it can launch workers.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

COMMITS = {
    'breeze': 'daa6cb2efe5471f09369229f322d20bb956cb3c3',
    'gpt': 'e91506f1fba265e1841617c3042a1573206a7351',
}
BREEZE_REV = '3e28c5151381a722f1d8661b4118c298caa77aa4'
SHARED_VERSION = 'zipformer-98590b7e-sherpa-2.0.1-py31210'
SDK = {'asr':'voice-shared-runtime', 'breeze':'voice-breeze', 'gpt':'voice-gpt-sovits'}
SKIP = {'.git', '.cache', '__pycache__', '.pytest_cache'}
FFMPEG_LICENSE = 'FFmpeg local dependency; see ffmpeg/LICENSE and ffmpeg/README.txt from the supplying distribution.'
CLOUD_DEPENDENCIES = {'httpx': '0.28.1', 'websockets': '17.4'}


def regular(path):
    if path.is_symlink() or path.is_junction() or not path.is_file():
        raise ValueError(f'Expected an ordinary file: {path}')
    return path


def tree(root, target, *, excluded=()):
    if not root.is_dir() or root.is_symlink() or root.is_junction():
        raise ValueError(f'Missing or invalid component directory: {root}')
    for current, folders, files in os.walk(root):
        folder = Path(current)
        folders[:] = sorted(name for name in folders if name not in SKIP and name not in excluded)
        for name in folders:
            if (folder/name).is_symlink() or (folder/name).is_junction():
                raise ValueError(f'Link in component: {folder/name}')
        for name in sorted(files):
            if name.endswith(('.pyc', '.pyo', '.log')) or name == '.gitignore':
                continue
            source = regular(folder / name)
            yield ((target / source.relative_to(root)).as_posix(), source, None)


def git_files(root, kind):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True, encoding='utf-8').strip()
    if git('rev-parse', 'HEAD') != COMMITS[kind] or git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError(f'{kind} engine checkout differs from the verified source')
    selected = ('breeze_infer', 'models', 'configs') if kind == 'breeze' else ('GPT_SoVITS', 'tools')
    for path in git('ls-files', '--', 'LICENSE', 'config.py', *selected).splitlines():
        yield path, regular(root/path), None


def python_runtime(base, venv):
    cfg = (venv/'pyvenv.cfg').read_text(encoding='utf-8')
    if 'version = 3.12.10' not in cfg or venv.resolve() == base.resolve():
        raise ValueError('Expected the verified CPython 3.12.10 environment')
    for name in ('python.exe', 'python3.dll', 'python312.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt'):
        yield f'python/{name}', regular(base/name), None
    yield from tree(base/'DLLs', Path('python/DLLs'))
    yield from tree(base/'Lib', Path('python/Lib'), excluded=('site-packages', 'test', 'tests', 'idlelib', 'tkinter', 'turtledemo'))
    yield from tree(venv/'Lib/site-packages', Path('python/Lib/site-packages'))


def inventory(args):
    if args.kind == 'asr':
        for name, version in CLOUD_DEPENDENCIES.items():
            metadata = args.venv/'Lib/site-packages'/f'{name}-{version}.dist-info/METADATA'
            text = regular(metadata).read_text(encoding='utf-8')
            if f'\nVersion: {version}\n' not in '\n'+text:
                raise ValueError(f'Shared cloud dependency differs from the verified environment: {name}')
    yield from python_runtime(args.python_base, args.venv)
    if args.kind == 'asr':
        row = json.loads((args.engine_root/'assets.json').read_text(encoding='utf-8'))
        for asset in row['assets']:
            name = asset['file'].replace('\\', '/').split('/models/', 1)[1]
            yield 'models/'+name, regular(args.engine_root/'models'/name), asset['source']
    elif args.kind == 'breeze':
        yield from git_files(args.engine_root, args.kind)
        for relative, source, _ in tree(args.engine_root/'checkpoints', Path('checkpoints')):
            upstream = relative.removeprefix('checkpoints/')
            yield relative, source, f'https://huggingface.co/BreezeBlue/breeze-tts-2/resolve/{BREEZE_REV}/{upstream}'
    else:
        yield from git_files(args.engine_root, args.kind)
        for folder in ('GPT_SoVITS/pretrained_models', 'GPT_SoVITS/text/G2PWModel'):
            yield from tree(args.engine_root/folder, Path(folder))
        for relative in ('GPT_SoVITS/text/engdict_cache.pickle', 'GPT_SoVITS/text/namedict_cache.pickle',
                         'GPT_SoVITS/text/g2pw/polyphonic.pickle', 'GPT_SoVITS/text/g2pw/polyphonic.md5'):
            yield relative, regular(args.engine_root/relative), None
        yield 'ffmpeg/ffmpeg.exe', regular(args.ffmpeg), None
        for name in ('LICENSE', 'README.txt'):
            yield f'ffmpeg/{name}', regular(args.ffmpeg.parent.parent/name), None


def snapshot(item):
    relative, source, url = item
    before = source.stat()
    with source.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f'Component changed while hashing: {relative}')
    return {'path':relative, 'bytes':before.st_size, 'sha256':sha, **({'url':url} if url else {})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=tuple(SDK))
    parser.add_argument('--engine-root', required=True, type=Path)
    parser.add_argument('--venv', required=True, type=Path)
    parser.add_argument('--python-base', required=True, type=Path)
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--seed', type=Path, help='Fresh user-owned offline component output directory')
    parser.add_argument('--resume', action='store_true', help='Resume an interrupted isolated offline seed, verifying existing files')
    parser.add_argument('--descriptor', required=True, type=Path)
    args = parser.parse_args()
    if args.kind == 'gpt' and args.ffmpeg is None:
        parser.error('GPT needs --ffmpeg from the pinned offline environment')
    selected = {}
    for entry in inventory(args):
        key = entry[0].casefold()
        if key in selected and selected[key][1] != entry[1]:
            raise ValueError(f'Component has colliding paths: {entry[0]}')
        selected[key] = entry
    files = sorted(selected.values(), key=lambda value: value[0])
    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(snapshot, files))
    descriptor = {'schemaVersion':1, 'platform':'win32', 'arch':'x64', 'kind':args.kind,
                  'version': SHARED_VERSION if args.kind == 'asr' else COMMITS[args.kind][:12]+'-py31210',
                  'python':'python/python.exe', 'files':rows}
    if args.kind == 'gpt':
        descriptor.update(ffmpegDirectory='ffmpeg', ffmpegNotice=FFMPEG_LICENSE,
                          executionProfile={'model':'v5turbo', 'precision':'fp16', 'sampleSteps':4},
                          licenseNotes={'engine':'MIT; see LICENSE',
                                        'assets':'Pretrained and third-party components retain their original licenses; inspect their included notices before distribution.'})
    elif args.kind == 'breeze':
        descriptor.update(modelRevision=BREEZE_REV,
                          executionProfile={'precision':'bf16', 'guidanceScale':4, 'cudaGraph':True},
                          licenseNotes={'engine':'Apache-2.0; see LICENSE',
                                        'weights':'BreezeBlue Research and Non-Commercial License v1.1; see checkpoints/LICENSE',
                                        'tokenizer':'Apache-2.0; see checkpoints/audio_tokenizer/LICENSE when supplied',
                                        'selfHostedOutputs':'Research and non-commercial use; commercial use requires separate written permission from BreezeBlue.'})
    else:
        descriptor.update(capabilities=['local-streaming-asr','minimax-tts'],
                          cloudDependencies=CLOUD_DEPENDENCIES,
                          licenseNotes={'python':'Python Software Foundation; see python/LICENSE.txt',
                                        'packages':'Individual installed distributions retain their bundled LICENSE and dist-info notices.',
                                        'models':'Zipformer/Silero assets retain their upstream terms and source revisions.'})
    if args.kind in COMMITS:
        descriptor['engineCommit'] = COMMITS[args.kind]
    if args.seed:
        args.seed.mkdir(exist_ok=args.resume)
        for (relative, source, _), expected in zip(files, rows):
            target = args.seed/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink():
                raise ValueError(f'Seed contains a symbolic link: {relative}')
            if args.resume and target.is_file() and target.stat().st_size == expected['bytes']:
                if snapshot((relative, target, None))['sha256'] == expected['sha256']:
                    continue
            temporary = target.with_name(target.name+'.preparing')
            shutil.copyfile(source, temporary)
            temporary.replace(target)
    with args.descriptor.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(descriptor, output, ensure_ascii=False, separators=(',', ':'))
        output.write('\n')
    print(json.dumps({'kind':args.kind, 'files':len(rows), 'bytes':sum(row['bytes'] for row in rows)}))


if __name__ == '__main__':
    main()
