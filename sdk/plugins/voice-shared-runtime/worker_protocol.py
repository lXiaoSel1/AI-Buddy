"""Private stdin/stdout transport. Only AI Buddy owns the pipe and process."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path


class WorkerError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def directory(request, key):
    value = Path(request[key])
    if not value.is_absolute() or not value.is_dir():
        raise WorkerError('VOICE_ASSETS_INVALID', '语音资源目录未准备')
    return value.resolve(strict=True)


def reference(request):
    row = request['reference']
    file = Path(row['path'])
    text, language = row['text'], row['language']
    if (not file.is_absolute() or not file.is_file() or file.suffix.lower() != '.wav'
            or not isinstance(text, str) or not 0 < len(text) <= 500
            or language not in ('zh', 'en', 'ja', 'ko', 'yue')):
        raise WorkerError('VOICE_REFERENCE_INVALID', '声音参考无效')
    with file.open('rb') as stream:
        audio_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    text_sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
    return file, text, language, audio_sha, text_sha


def speech(request):
    text, instruction = request['text'], request.get('instruction', '')
    if (not isinstance(text, str) or not text.strip() or len(text) > 240
            or not isinstance(instruction, str) or len(instruction) > 500):
        raise WorkerError('VOICE_TTS_INVALID', '配音请求无效')
    return text, instruction


def worker(handler):
    # Preserve the IPC stream and keep model imports/native logs off it.
    ipc = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
    with open(os.devnull, 'w') as quiet:
        os.dup2(quiet.fileno(), sys.stdout.fileno())
        os.dup2(quiet.fileno(), sys.stderr.fileno())
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line or len(line) > 65536 or not line.endswith(b'\n'):
            break
        request_id = None
        try:
            request = json.loads(line)
            request_id = request['id']
            if not isinstance(request_id, int) or request_id <= 0:
                break
            for event in handler(request):
                ipc.write(json.dumps({'id': request_id, **event}, ensure_ascii=False, allow_nan=False)+'\n')
        except WorkerError as exc:
            ipc.write(json.dumps({'id': request_id, 'type':'error', 'code': exc.code, 'message':str(exc)}, ensure_ascii=False)+'\n')
        except Exception as exc:
            # Native errors may contain private paths or the user's text.
            kind = re.sub('[^A-Za-z0-9_]', '', type(exc).__name__)[:40]
            ipc.write(json.dumps({'id': request_id, 'type':'error', 'code':'VOICE_WORKER_ERROR',
                                  'message':'语音组件运行失败 ('+kind+')'}, ensure_ascii=False)+'\n')

