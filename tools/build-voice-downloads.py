"""Build bounded, deterministic voice delivery ZIPs from a pinned inventory.

This does not publish, sign, install, execute or download anything. With no
base URL it emits an explicitly non-installable template for release staging.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
LIMIT = 2 * 1024 ** 3


def sha_file(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def save(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def relative_path(name):
    path = PurePosixPath(name)
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or path.is_absolute() or any(part in ('', '.', '..') for part in name.split('/'))
            or any(ord(char) < 32 for char in name)):
        raise ValueError('Invalid inventory path')
    return name


def https(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
            or parsed.password or parsed.port or parsed.fragment):
        raise ValueError('Invalid delivery HTTPS URL')
    return value


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def source_file(root, name):
    current = root
    for part in relative_path(name).split('/'):
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise ValueError('Linked inventory source is not accepted')
    info = current.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Inventory source is not a regular file')
    return current, info


def build(args):
    raw = args.manifest.read_bytes()
    inventory = json.loads(raw)
    kind = inventory['kind']
    if kind not in ('asr', 'breeze', 'gpt') or inventory['schemaVersion'] != 1:
        raise ValueError('Unsupported inventory kind/version')
    files = inventory['files']
    indexed = {relative_path(row['path']): row for row in files}
    if len({name.casefold() for name in indexed}) != len(files):
        raise ValueError('Duplicate inventory path')
    overrides = []
    if args.direct_files:
        for row in json.loads(args.direct_files.read_bytes())['directFiles']:
            original = indexed.get(row['path'])
            if (not original or original.get('url') or row['bytes'] != original['bytes']
                    or row['sha256'] != original['sha256']
                    or any(old['path'] == row['path'] for old in overrides)):
                raise ValueError('Delivery override differs from inventory hash/size')
            overrides.append({'path': row['path'], 'url': https(row['url'])})
    direct = {row['path'] for row in overrides}
    needed = sorted((row for row in files if not row.get('url') and row['path'] not in direct), key=lambda row: row['path'])
    groups, group, count = [], [], 0
    for row in needed:
        if not isinstance(row['bytes'], int) or row['bytes'] < 0 or row['bytes'] > LIMIT - 1048576:
            raise ValueError('Inventory file exceeds bounded ZIP size')
        if group and count + row['bytes'] > args.part_bytes:
            groups.append(group)
            group, count = [], 0
        group.append(row)
        count += row['bytes']
        if count >= args.part_bytes:
            groups.append(group)
            group, count = [], 0
    if group:
        groups.append(group)
    if args.source.is_symlink() or args.source.is_junction():
        raise ValueError('Linked inventory source root is not accepted')
    args.out.mkdir(parents=True, exist_ok=False)
    archives = []
    for index, rows in enumerate(groups, 1):
        name = f'voice-{kind}-runtime-{index:03d}.zip'
        destination = args.out / name
        with zipfile.ZipFile(destination, 'x', zipfile.ZIP_DEFLATED, allowZip64=False, compresslevel=1) as archive:
            for row in rows:
                source, before = source_file(args.source, row['path'])
                if before.st_size != row['bytes']:
                    raise ValueError('Inventory source size mismatch: ' + row['path'])
                entry = zipfile.ZipInfo(row['path'], (2026, 11, 8, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry._compresslevel = 1
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.file_size = row['bytes']
                digest, length = hashlib.sha256(), 0
                with source.open('rb') as input_stream, archive.open(entry, 'w') as output:
                    for chunk in iter(lambda: input_stream.read(1024 * 1024), b''):
                        length += len(chunk)
                        if length > row['bytes']:
                            raise ValueError('Inventory source grew: ' + row['path'])
                        digest.update(chunk)
                        output.write(chunk)
                if (length != row['bytes'] or digest.hexdigest() != row['sha256']
                        or identity(before) != identity(source.stat())):
                    raise ValueError('Inventory source hash/identity mismatch: ' + row['path'])
        size = destination.stat().st_size
        if size > LIMIT:
            raise ValueError('Compressed archive exceeds bounded ZIP size')
        record = {'id': f'{kind}-{index:03d}', 'format': 'zip', 'assetName': name,
                  'bytes': size, 'sha256': sha_file(destination), 'files': [row['path'] for row in rows]}
        archives.append(record)
        print(json.dumps({'kind': kind, 'part': index, 'parts': len(groups), 'bytes': size}), flush=True)
    delivery = {'schemaVersion': 1, 'assetsSha256': hashlib.sha256(raw).hexdigest(), 'archives': archives}
    if overrides:
        delivery['directFiles'] = overrides
    save(args.out / 'downloads.template.json', delivery)
    installable = None
    if args.base_url:
        base = https(args.base_url.rstrip('/') + '/')
        if urlsplit(base).query:
            raise ValueError('Delivery base URL cannot have a query')
        installable = dict(delivery, archives=[{key: value for key, value in dict(row, url=base + row['assetName']).items() if key != 'assetName'} for row in archives])
        save(args.out / 'downloads.json', installable)
    receipt = {'schemaVersion': 1, 'kind': kind, 'assetsSha256': delivery['assetsSha256'],
               'archiveCount': len(archives), 'archiveBytes': sum(row['bytes'] for row in archives),
               'packedInputBytes': sum(row['bytes'] for row in needed),
               'directBytes': sum(row['bytes'] for row in files if row.get('url') or row['path'] in direct),
               'publicDownloadReady': False, 'publicationPerformed': False, 'signingPerformed': False,
               'installableMetadataProduced': installable is not None,
               'note': 'Public download readiness requires actual release assets and authorized signed plugin metadata.'}
    save(args.out / 'PACKING.json', receipt)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--part-bytes', type=int, default=512 * 1024 ** 2)
    parser.add_argument('--direct-files', type=Path)
    parser.add_argument('--base-url')
    arguments = parser.parse_args()
    if arguments.part_bytes < 1 or arguments.part_bytes > LIMIT - 1048576:
        parser.error('part-bytes must fit the ZIP bound')
    try:
        print(json.dumps(build(arguments)), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
