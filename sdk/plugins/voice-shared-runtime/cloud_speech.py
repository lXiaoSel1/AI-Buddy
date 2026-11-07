"""Private pipe adapter for MiniMax cloud speech. No credentials on argv/disk."""
import asyncio
import base64
import contextlib
import json
import re
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit

import httpx
import websockets


class CloudError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.details = code, details


class Cancelled(Exception):
    pass


def emit(row):
    print(json.dumps(row, ensure_ascii=False), flush=True)


def base_url(request):
    value = request['base'].rstrip('/')
    url = urlsplit(value)
    if url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise CloudError('CLOUD_ENDPOINT', '云端语音地址无效')
    if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')):
        raise CloudError('CLOUD_ENDPOINT', '云端语音需要 HTTPS')
    return value


def checked(response):
    if response.status_code != 200:
        raise CloudError('CLOUD_HTTP_' + str(response.status_code), 'MiniMax 语音服务返回 HTTP ' + str(response.status_code))
    try:
        value = response.json()
    except Exception:
        raise CloudError('CLOUD_PROTOCOL', 'MiniMax 返回了无效响应') from None
    check_status(value)
    return value


def check_status(value):
    if not isinstance(value, dict):
        raise CloudError('CLOUD_PROTOCOL', 'MiniMax 返回了无效事件')
    status = value.get('base_resp', {}).get('status_code', 0)
    if status != 0:
        # Upstream descriptions and response bodies are never reflected: they
        # can contain caller-controlled text or accidentally echoed secrets.
        code = str(status) if isinstance(status, int) else 'UNKNOWN'
        raise CloudError('CLOUD_REMOTE_' + code, 'MiniMax 语音服务返回错误（' + code + '）')


def client(request):
    return httpx.AsyncClient(headers={'Authorization': 'Bearer ' + request['key']},
                             timeout=httpx.Timeout(120, connect=15), trust_env=False, follow_redirects=False)


async def voices(request):
    async with client(request) as http:
        value = checked(await http.post(base_url(request) + '/v1/get_voice', json={'voice_type': 'all'}))
    result = []
    for category in ('system_voice', 'voice_cloning', 'voice_generation'):
        rows = value.get(category) or []
        if not isinstance(rows, list):
            raise CloudError('CLOUD_PROTOCOL', 'MiniMax 音色目录无效')
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get('voice_id'), str):
                result.append({'voice_id': row['voice_id'], 'category': category,
                               'name': row.get('voice_name') or row['voice_id']})
    emit({'type': 'result', 'voices': result})


async def clone_voice(request):
    audio = base64.b64decode(request['audio'], validate=True)
    if len(audio) > 20 * 1024 * 1024 or audio[:4] != b'RIFF' or audio[8:12] != b'WAVE':
        raise CloudError('CLOUD_AUDIO', '云克隆需要已批准的完整 WAV 录音')
    async with client(request) as http:
        uploaded = checked(await http.post(base_url(request) + '/v1/files/upload',
                                          data={'purpose': 'voice_clone'}, files={'file': ('voice-reference.wav', audio, 'audio/wav')}))
        file_id = uploaded.get('file', {}).get('file_id')
        if not isinstance(file_id, (str, int)):
            raise CloudError('CLOUD_PROTOCOL', 'MiniMax 没有返回上传文件标识')
        emit({'type': 'stage', 'stage': 'uploaded', 'file_id': file_id})
        body = {'file_id': file_id, 'voice_id': request['voiceId'],
                'need_noise_reduction': False, 'need_volume_normalization': False}
        if request.get('textValidation'):
            body['text_validation'] = request['textValidation']
        emit({'type': 'stage', 'stage': 'clone-request-submitted', 'file_id': file_id})
        checked(await http.post(base_url(request) + '/v1/voice_clone', json=body))
        # Deliberately omit text/model: creating a voice must not silently run
        # a separately billed preview. First synthesis is a user action.
    emit({'type': 'result', 'voice_id': request['voiceId'], 'file_id': file_id})


async def receive(ws, cancelled, timeout=120):
    read = asyncio.create_task(ws.recv())
    stop = asyncio.create_task(cancelled.wait())
    try:
        ready, _ = await asyncio.wait({read, stop}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if stop in ready:
            raise Cancelled()
        if read not in ready:
            raise CloudError('CLOUD_TIMEOUT', '云端语音响应超时')
        try:
            value = json.loads(read.result())
        except (ValueError, TypeError):
            raise CloudError('CLOUD_PROTOCOL', 'MiniMax 返回了无效流式事件') from None
        check_status(value)
        return value
    finally:
        for task in (read, stop):
            if not task.done():
                task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


async def speak(request, cancelled):
    started_at = time.perf_counter()
    endpoint = base_url(request).replace('https://', 'wss://', 1).replace('http://', 'ws://', 1) + '/ws/v1/t2a_v2_bidi'
    session_id = 'buddy-' + uuid.uuid4().hex
    voice = {'voice_id': request['voiceId'], 'speed': 1, 'vol': 1, 'pitch': 0}
    emotion = (request.get('performance') or {}).get('emotion')
    if emotion == 'neutral':
        emotion = 'calm'
    if emotion in ('happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'):
        voice['emotion'] = emotion
    first_pcm, total_bytes, tail, trace_id = None, 0, b'', None
    async with websockets.connect(endpoint, additional_headers={'Authorization': 'Bearer ' + request['key']},
                                  open_timeout=15, close_timeout=3, ping_interval=20, ping_timeout=20,
                                  max_size=8 * 1024 * 1024) as ws:
        started = False
        try:
            event = await receive(ws, cancelled)
            if event.get('event') != 'connected_success':
                raise CloudError('CLOUD_PROTOCOL', 'MiniMax 未确认语音连接')
            await ws.send(json.dumps({'event': 'task_start', 'session_id': session_id, 'model': request['model'],
                                      'language_boost': 'Chinese', 'voice_setting': voice,
                                      'audio_setting': {'format': 'pcm', 'sample_rate': 32000, 'channel': 1}}))
            event = await receive(ws, cancelled)
            if event.get('event') != 'task_started':
                raise CloudError('CLOUD_PROTOCOL', 'MiniMax 未确认语音任务')
            started = True
            parts = request.get('speechParts')
            if not isinstance(parts, list) or not 1 <= len(parts) <= 3 or not all(isinstance(part, str) and part.strip() for part in parts) or ''.join(parts) != request['text']:
                parts = [request['text']]
            for part in parts:
                await ws.send(json.dumps({'event': 'task_continue', 'text': part}, ensure_ascii=False))
            await ws.send(json.dumps({'event': 'task_flush'}))
            flushed = False
            while True:
                event = await receive(ws, cancelled)
                trace_id = event.get('trace_id', trace_id)
                if event.get('event') == 'task_failed':
                    raise CloudError('CLOUD_REMOTE', 'MiniMax 语音任务失败')
                data = event.get('data')
                if isinstance(data, dict) and data.get('audio'):
                    hexadecimal = data['audio']
                    if not isinstance(hexadecimal, str) or len(hexadecimal) % 2 or not re.fullmatch('[a-fA-F0-9]+', hexadecimal):
                        raise CloudError('CLOUD_PROTOCOL', 'MiniMax 返回了无效音频编码')
                    pcm = tail + bytes.fromhex(hexadecimal)
                    tail = pcm[len(pcm) // 2 * 2:]
                    pcm = pcm[:len(pcm) // 2 * 2]
                    if pcm:
                        first_pcm = first_pcm if first_pcm is not None else time.perf_counter() - started_at
                        total_bytes += len(pcm)
                        emit({'type': 'pcm', 'pcm': base64.b64encode(pcm).decode('ascii'), 'sample_rate': 32000})
                if event.get('event') == 'task_flushed':
                    flushed = True
                    await ws.send(json.dumps({'event': 'task_finish'}))
                if event.get('event') == 'task_finished':
                    if not flushed:
                        raise CloudError('CLOUD_INCOMPLETE', 'MiniMax 没有确认完整尾音')
                    break
            if tail or not total_bytes:
                raise CloudError('CLOUD_INCOMPLETE', 'MiniMax 没有返回完整 PCM 音频')
        except Cancelled:
            if started:
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({'event': 'task_cancel'}))
                    # Ignore already delivered packets while waiting for actual
                    # cancellation; local playback is revoked by the host.
                    async with asyncio.timeout(2):
                        while True:
                            reply = json.loads(await ws.recv())
                            if reply.get('event') == 'task_canceled':
                                break
            raise
    emit({'type': 'done', 'metrics': {'cloud': True, 'voice_id': request['voiceId'], 'model': request['model'],
                                    'trace_id': trace_id, 'first_pcm_seconds': first_pcm,
                                    'generation_seconds': time.perf_counter() - started_at,
                                    'audio_seconds': total_bytes / 2 / 32000, 'input_text_chunks': len(parts),
                                    'performance_control': 'mapped-emotion' if 'emotion' in voice else 'cloud-text-automatic',
                                    'pcm_encoding': 's16le-assumption-awaiting-live-verification'}})


async def cancelable_http(operation, cancelled):
    task, stop = asyncio.create_task(operation), asyncio.create_task(cancelled.wait())
    try:
        ready, _ = await asyncio.wait({task, stop}, return_when=asyncio.FIRST_COMPLETED)
        if stop in ready:
            raise Cancelled()
        await task
    finally:
        for item in (task, stop):
            if not item.done():
                item.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await item


async def main(request):
    cancelled = asyncio.Event()
    loop = asyncio.get_running_loop()
    def read_control():
        for line in sys.stdin:
            try:
                if json.loads(line).get('op') == 'cancel':
                    loop.call_soon_threadsafe(cancelled.set)
                    return
            except (ValueError, RuntimeError):
                return
    threading.Thread(target=read_control, daemon=True).start()
    operation = request.get('op')
    if operation == 'speak':
        await speak(request, cancelled)
    elif operation == 'voices':
        await cancelable_http(voices(request), cancelled)
    elif operation == 'clone':
        await cancelable_http(clone_voice(request), cancelled)
    elif operation == 'cancel':
        raise Cancelled()
    else:
        raise CloudError('CLOUD_PROTOCOL', '云端语音操作无效')


if __name__ == '__main__':
    try:
        asyncio.run(main(json.loads(sys.stdin.readline())))
    except Cancelled:
        emit({'type': 'cancelled'})
    except CloudError as error:
        emit({'type': 'error', 'code': error.code, 'message': str(error), **({'details': error.details} if error.details else {})})
        sys.exit(1)
    except Exception:
        emit({'type': 'error', 'code': 'CLOUD_CONNECTION', 'message': '云端语音连接失败，请核对网络和 API 设置'})
        sys.exit(1)
