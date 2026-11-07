"""Shared CPU-only Zipformer + Silero, at 16 kHz mono PCM16."""
import base64

from worker_protocol import directory, worker, WorkerError


def serve():
    engine = capture = None
    frames = 0

    def handle(request):
        nonlocal engine, capture, frames
        op = request['op']
        if op == 'initialize' and engine is None:
            from asr import SpeechEngine
            engine = SpeechEngine(directory(request, 'assetRoot'))
            yield {'type':'result', 'state':'ready', 'load_seconds':engine.load_seconds}
        elif op == 'capture' and engine is not None and capture is None:
            capture = engine.session()
            frames = 0
            yield {'type':'result'}
        elif op == 'feed' and capture is not None:
            import numpy as np
            raw = base64.b64decode(request['pcm'], validate=True)
            if not 0 < len(raw) <= 32000 or len(raw) % 2:
                raise WorkerError('VOICE_AUDIO_INVALID', '录音数据无效')
            samples = np.frombuffer(raw, dtype='<i2')[:max(0, 120 * 16000 - frames)]
            frames += len(samples)
            partial = capture.feed(samples.astype(np.float32) / 32768) if len(samples) else capture.text
            yield {'type':'result', 'partial':partial, 'endpoint':capture.ended, 'limit':frames >= 120 * 16000}
        elif op == 'finish' and capture is not None:
            try:
                text = capture.finish()
            finally:
                capture = None
            yield {'type':'result', 'text':text}
        else:
            raise WorkerError('VOICE_CAPTURE_INACTIVE', '录音会话已结束')

    worker(handle)


if __name__ == '__main__':
    serve()
