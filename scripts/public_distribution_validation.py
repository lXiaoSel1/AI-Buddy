"""Read-only public distribution v2 validation shared by packaging entrypoints."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import shutil
from uuid import uuid4

APPLICATION_VERSION = '2.0.16'
MEDIA_BASE_VERSION = '1.9.2'
BASELINE_SHA256 = '12ac599d424e678acb1c7f964c65551fdc48dc40ac31ea47facb253256a7b871'
APPROVAL_SHA256 = '30f610d52dc03aee82baaddd31e1f081abd2be22758c3e66e7a74235e30428fb'
INVENTORY_SHA256 = '346a3abcbc3384f93e90c4f4b7a4adf1233c2066ebbab5d6605c0b277c69538c'
CHARACTERS = ('deepseek', 'claude', 'grok', 'seed', 'kimi', 'qwen', 'minimax', 'chatgpt', 'gemini', 'glm', 'hunyuan')


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    no_links(path)
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def no_links(path):
    target = Path(os.path.abspath(path))
    for part in (target, *target.parents):
        require(not part.is_symlink() and not getattr(part, 'is_junction', lambda: False)(), 'Linked distribution ancestor: ' + str(part))
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        require(not getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400), 'Linked distribution reparse point: ' + str(part))
    return target


class OwnedOutput:
    """Existing output trees are resumable regular files; writes never follow or truncate aliases."""

    def __init__(self, root, fresh=False):
        require(Path(root).is_absolute(), 'Explicit absolute output root required')
        self.root = no_links(root)
        if self.root.exists():
            require(not fresh and self.root.is_dir(), 'Fresh directory output required')
            for directory, dirs, files in os.walk(self.root, followlinks=False):
                for name in (*dirs, *files):
                    item = no_links(Path(directory) / name)
                    require(stat.S_ISDIR(item.lstat().st_mode) or stat.S_ISREG(item.lstat().st_mode), 'Unsupported existing output entry: ' + str(item))

    def target(self, path, directory=False, fresh=False, required=False):
        path = Path(os.path.abspath(path))
        require(path.is_relative_to(self.root) and (directory or path != self.root), 'Target is outside owned output')
        no_links(path)
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            require(not required, 'Required output is missing: ' + str(path))
        else:
            require(not fresh, 'Fresh output target required: ' + str(path))
            require(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), 'Output target has the wrong file type: ' + str(path))
        return path

    def directory(self, path, fresh=False):
        target = self.target(path, directory=True, fresh=fresh)
        target.mkdir(parents=True, exist_ok=not fresh)
        return self.target(target, directory=True, required=True)

    def read_json(self, path, encoding='utf-8'):
        return json.loads(self.target(path, required=True).read_text(encoding=encoding))

    def open_read(self, path):
        return self.target(path, required=True).open('rb')

    def write_bytes(self, path, value, replace=True):
        target = self.target(path, fresh=not replace)
        self.directory(target.parent)
        temporary = self.target(target.with_name('.' + target.name + '.' + uuid4().hex + '.tmp'), fresh=True)
        with temporary.open('xb') as stream:
            stream.write(value)
        self.target(target, fresh=not replace)
        # Atomic leaf replacement does not modify a pre-existing hardlink's other names.
        if replace:
            os.replace(self.target(temporary, required=True), target)
        else:
            self.commit_file(temporary, target)
        return self.target(target, required=True)

    def write_text(self, path, value, encoding='utf-8', replace=True):
        return self.write_bytes(path, value.encode(encoding), replace=replace)

    def copy_file(self, source, destination):
        source = no_links(source)
        require(stat.S_ISREG(source.lstat().st_mode), 'Copy source is not a regular file')
        destination = self.target(destination, fresh=True)
        self.directory(destination.parent)
        with source.open('rb') as src, self.target(destination, fresh=True).open('xb') as dest:
            shutil.copyfileobj(src, dest, 1024 * 1024)
        return self.target(destination, required=True)

    def copy_tree(self, source, destination):
        source, destination = no_links(source), self.target(destination, directory=True, fresh=True)
        self.directory(destination.parent)

        def link_file(src, dest):
            src, dest = no_links(src), self.target(dest, fresh=True)
            require(stat.S_ISREG(src.lstat().st_mode), 'Copy source is not a regular file')
            os.link(src, dest)

        shutil.copytree(source, destination, copy_function=link_file)
        return self.target(destination, directory=True, required=True)

    def commit_file(self, temporary, target):
        temporary, target = self.target(temporary, required=True), self.target(target, fresh=True)
        # Exclusive creation keeps a concurrently introduced leaf from being overwritten.
        os.link(temporary, target)
        self.target(temporary, required=True).unlink()
        return self.target(target, required=True)


def boundaries(inputs=(), outputs=(), fresh=()):
    require(all(Path(p).is_absolute() for p in (*inputs, *outputs)), 'Explicit absolute distribution paths required')
    ins, outs = [no_links(p) for p in inputs], [no_links(p) for p in outputs]

    def overlap(a, b):
        left, right = str(a).casefold(), str(b).casefold()
        prefix = lambda value: value if value.endswith(os.sep) else value + os.sep
        return left == right or left.startswith(prefix(right)) or right.startswith(prefix(left))

    require(not any(overlap(a, b) for a in ins for b in outs), 'Distribution input/output overlap')
    require(not any(overlap(a, b) for index, a in enumerate(outs) for b in outs[index + 1:]), 'Distribution output/output overlap')
    require(not any(Path(p).exists() for p in fresh), 'Fresh distribution output required')


def public_path(name, allow_portable_defaults=False):
    require(isinstance(name, str) and not re.search(r'(^|/)bili-media/|(^|/)(ffmpeg|ffplay|ffprobe|whisper-cli)\.exe$|(^|/)ggml-[^/]+\.bin$', name, re.I), 'Upstream media binaries are not redistributed')
    require(isinstance(name, str) and bool(name) and not PurePosixPath(name).is_absolute(), 'Unsafe public file path')
    for part in name.split('/'):
        require(part not in ('', '.', '..') and not re.search(r'[\\<>:"|?*\x00-\x1f]', part) and part[-1:] not in ('.', ' ') and not re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I), 'Unsafe public file path')
    if allow_portable_defaults and (name in ('local/portable-defaults.json', 'local/current-build.json') or re.fullmatch(r'local/install-manifests/[a-f0-9]{64}\.json', name)):
        return
    require(not re.search(r'(^|/)(local|test-data|receipts|node_modules|\.ssh|\.git)(/|$)|work-collaboration|(^|/)(\.env|companion\.json|accounts-v1\.sqlite|runtime-audit\.jsonl)$', name, re.I), 'Private or deferred public file: ' + name)


def file_map(rows, owners=False, allow_portable_defaults=False):
    require(isinstance(rows, list), 'Missing file inventory')
    result, folded = {}, set()
    for row in rows:
        require(isinstance(row, dict), 'Invalid file row')
        name = row.get('path')
        public_path(name, allow_portable_defaults)
        require(name.casefold() not in folded and type(row.get('bytes')) is int and row['bytes'] >= 0 and re.fullmatch(r'[a-f0-9]{64}', row.get('sha256', '')), 'Duplicate or invalid file inventory')
        if owners:
            require(row.get('owner') in ('shared', *CHARACTERS), 'Invalid resource owner')
        folded.add(name.casefold())
        result[name] = row
    return result


def scan_public(base, allow_portable_defaults=False):
    base = no_links(base)
    require(base.is_dir(), 'Missing distribution directory')
    rows = []
    for directory, dirs, files in os.walk(base, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(directory) / name
            no_links(path)
            mode = path.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'Unsupported distribution entry')
        for name in sorted(files):
            path = Path(directory) / name
            rows.append(dict(path=path.relative_to(base).as_posix(), bytes=path.stat().st_size, sha256=digest(path)))
    return file_map(sorted(rows, key=lambda row: row['path']), allow_portable_defaults=allow_portable_defaults)


def read_json(path):
    no_links(path)
    return json.loads(Path(path).read_text(encoding='utf-8'))


def load_inventory(inventory_path=None, inventory_sha256=None):
    require((inventory_path is None) == (inventory_sha256 is None), 'Inventory path and trusted digest must be supplied together')
    path = inventory_path or Path(__file__).parent / 'media-baselines/public-204-assets.json'
    expected = inventory_sha256 or INVENTORY_SHA256
    no_links(path)
    require(digest(path) == expected, 'Approved asset inventory changed')
    inventory = read_json(path)
    require(inventory.get('schemaVersion') == 1 and inventory.get('kind') == 'ai-buddy-public-distribution-assets' and inventory.get('applicationVersion') == APPLICATION_VERSION and inventory.get('mediaBaseVersion') == MEDIA_BASE_VERSION, 'Unsupported approved inventory schema/version')
    basis = inventory.get('basis', {})
    require(basis.get('optimizedBaselineSha256') == BASELINE_SHA256 and basis.get('approvalSha256') == APPROVAL_SHA256 and re.fullmatch(r'[a-f0-9]{64}', basis.get('legacyLockSha256', '')), 'Original approval digest binding differs')
    editions = inventory.get('editions')
    require(isinstance(editions, list) and len(editions) == 2 and {e.get('fps') for e in editions} == {30, 60}, 'Incomplete approved editions')
    source = file_map(inventory.get('sourceAssets'), owners=True)
    for row in source.values():
        require(row['owner'] == 'shared' and re.match(r'^assets/(group-thumbnails|group-scene|card-games|food|pet-glove-v2|theme|pet-glove-tint)/', row['path']), 'Unapproved source UI scope')
    for edition in editions:
        require(edition.get('profile') == str(edition['fps']) + 'fps', 'Approved profile mismatch')
        assets, videos = file_map(edition.get('assets'), owners=True), file_map(edition.get('videos'))
        require(len(videos) == 264 and sum(p.endswith('.webm') for p in assets) == 264, 'Incomplete approved video coverage')
        identities = set()
        for video in videos.values():
            key = video.get('characterId', '') + '/' + video.get('actionId', '')
            asset = assets.get(video['path'], {})
            require(video.get('characterId') in CHARACTERS and video.get('key') == key and key not in identities and video.get('fps') == edition['fps'] and re.fullmatch(r'[a-f0-9]{64}', video.get('metadataSha256', '')) and asset.get('owner') == video['characterId'] and all(asset.get(k) == video[k] for k in ('bytes', 'sha256')), 'Approved video identity differs')
            identities.add(key)
        require(all(sum(v['characterId'] == name for v in videos.values()) == 24 for name in CHARACTERS), 'Each character requires 24 actions')
        require(all(assets.get(name) == row for name, row in source.items()), 'Approved source UI binding differs')
    return inventory, expected


def upstream_media(base):
    descriptor = read_json(Path(__file__).resolve().parent.parent / 'release/bili-ffmpeg-upstream.json')
    identity = hashlib.sha256(json.dumps(descriptor, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    require(read_json(base / 'bili-ffmpeg-upstream.json') == descriptor and read_json(base / 'bili-media-mode.json') == dict(schemaVersion=1, mode='upstream-component', descriptorSha256=identity, localSpeechRecognition=False), 'Public build must use the fixed upstream media descriptor')
    require((base / 'ffmpeg-component-worker.mjs').is_file(), 'Public FFmpeg worker is missing')
    for row in descriptor['files']:
        if row['path'] != descriptor['executable']:
            target = no_links(base / 'media-notices/ffmpeg' / row['path'])
            require(target.stat().st_size == row['bytes'] and digest(target) == row['sha256'], 'Public upstream notice changed')


def validated_trees(candidate, inventory_path=None, inventory_sha256=None):
    candidate = no_links(candidate)
    inventory, expected = load_inventory(inventory_path, inventory_sha256)
    require({p.name for p in candidate.iterdir()} == {'30fps', '60fps', 'root', 'runtime', 'media-proof.json', 'approved-assets.json'}, 'Unexpected candidate entry')
    require(digest(candidate / 'approved-assets.json') == expected, 'Candidate approved inventory changed')
    proof = read_json(candidate / 'media-proof.json')
    require(proof.get('schemaVersion') == 2 and proof.get('kind') == 'ai-buddy-public-distribution' and proof.get('ok') is True and proof.get('version') == APPLICATION_VERSION and proof.get('applicationVersion') == APPLICATION_VERSION and proof.get('mediaBaseVersion') == MEDIA_BASE_VERSION and proof.get('reencoded') == 0 and proof.get('workPluginIncluded') is False, 'Unsupported public distribution proof')
    require(proof.get('approvedAssets') == dict(file='approved-assets.json', sha256=expected, basis=inventory['basis']), 'Approved inventory proof differs')
    editions = proof.get('editions')
    require(isinstance(editions, list) and len(editions) == 2 and {e.get('fps') for e in editions} == {30, 60}, 'Incomplete distribution edition proof')
    trees, owners = {}, {}
    for fps in (30, 60):
        edition = str(fps) + 'fps'
        require({p.name for p in (candidate / edition).iterdir()} == {'build'}, 'Unexpected edition entry')
        base = candidate / edition / 'build'
        tree = trees[edition] = scan_public(base)
        upstream_media(base)
        accepted = next(e for e in inventory['editions'] if e['fps'] == fps)
        assets = file_map(accepted['assets'], owners=True)
        expected_assets = {name: {k: row[k] for k in ('path', 'bytes', 'sha256')} for name, row in assets.items()}
        require({p: row for p, row in tree.items() if p.startswith('assets/') and p != 'assets/install-resource-index.json'} == expected_assets, 'Candidate assets differ from approved complete inventory')
        package, index = read_json(base / 'package.json'), read_json(base / 'assets/install-resource-index.json')
        require(package.get('version') == APPLICATION_VERSION and package.get('animationProfile') == edition, 'Candidate application version/profile mismatch')
        require({k: v for k, v in index.items() if k not in ('shared', 'characters')} == dict(version=1, appVersion=APPLICATION_VERSION, edition=edition, defaultCharacter='deepseek'), 'Resource index header differs')
        require(isinstance(index.get('characters'), dict) and set(index['characters']) == set(CHARACTERS), 'Resource character coverage differs')
        indexed = [dict(row, owner=owner) for owner, rows in [('shared', index.get('shared', [])), *index['characters'].items()] for row in rows]
        require(file_map(indexed, owners=True) == assets, 'Resource index must exactly cover every approved owner/file')
        for name in CHARACTERS:
            require(sum(row['path'].endswith('.webm') for row in index['characters'][name]) == 24, 'Character needs 24 action videos')
            for row in index['characters'][name]:
                require(row['path'] not in owners or owners[row['path']] == name, 'Resource owner differs between editions')
                owners[row['path']] = name
        accepted_proof = next(e for e in editions if e['fps'] == fps)
        require(accepted_proof.get('profile') == edition and accepted_proof.get('videos') == 264 and file_map(accepted_proof.get('files')) == tree and accepted_proof.get('resourceIndexSha256') == digest(base / 'assets/install-resource-index.json'), 'Candidate code/index changed after assembly')
        media = accepted_proof.get('mediaProof', {})
        require(media.get('mode') in ('optimized', 'optimized-public') and media.get('version') == APPLICATION_VERSION and media.get('mediaBaseVersion') == MEDIA_BASE_VERSION and media.get('fps') == fps and media.get('videos') == 264 and media.get('resources') == len(assets) and media.get('baselineSha256') == BASELINE_SHA256, 'Media proof version/identity differs')
    require(set(trees['30fps']) == set(trees['60fps']), 'Edition file sets differ')
    roots, runtime = scan_public(candidate / 'root'), scan_public(candidate / 'runtime')
    require(file_map(proof.get('roots')) == roots, 'Root files changed after assembly')
    runtime_proof = proof.get('runtime', {})
    require(file_map(runtime_proof.get('files')) == runtime and runtime_proof.get('executable') == 'AI Buddy.exe' and runtime_proof.get('sha256') == digest(candidate / 'runtime/AI Buddy.exe'), 'Runtime proof differs')
    runtime_manifest = read_json(candidate / 'runtime/runtime-manifest.json')
    require(runtime_manifest.get('version') == APPLICATION_VERSION and file_map(runtime_manifest.get('files')) == {p: row for p, row in runtime.items() if p != 'runtime-manifest.json'}, 'Runtime manifest differs')
    return trees, owners, proof
