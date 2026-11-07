"""CPU-only streaming recognition; independent of AI Buddy and Breeze."""
import threading
import time
from pathlib import Path
import numpy as np
import sherpa_onnx
from scipy.signal import resample_poly
from math import gcd


class SpeechEngine:
    def __init__(self, asset_root):
        started = time.perf_counter()
        self.assets = Path(asset_root)
        model = self.assets / 'models/zipformer'
        self.lock = threading.RLock()
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(model/'tokens.txt'), encoder=str(model/'encoder-epoch-99-avg-1.int8.onnx'),
            decoder=str(model/'decoder-epoch-99-avg-1.onnx'), joiner=str(model/'joiner-epoch-99-avg-1.int8.onnx'),
            num_threads=2, sample_rate=16000, decoding_method='greedy_search', provider='cpu')
        self.load_seconds = time.perf_counter() - started

    def session(self):
        return SpeechSession(self)

    def transcribe(self, audio, sample_rate):
        started = time.perf_counter()
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim == 2:
            audio = audio.mean(axis=1)
        if sample_rate != 16000:
            divisor = gcd(int(sample_rate), 16000)
            audio = resample_poly(audio, 16000//divisor, int(sample_rate)//divisor).astype(np.float32)
        if not np.isfinite(audio).all():
            raise ValueError('Audio must contain finite samples')
        session = self.session()
        partials = []
        last = ''
        for offset in range(0, len(audio), 1600):
            text = session.feed(audio[offset:offset+1600])
            if text and text != last:
                partials.append({'audio_time': min(offset+1600, len(audio))/16000, 'text': text})
                last = text
        text = session.finish()
        elapsed = time.perf_counter() - started
        duration = len(audio)/16000
        return {'text': text, 'audio_seconds': duration, 'processing_seconds': elapsed,
                'rtf': elapsed/max(duration, .001), 'partials': partials, 'speech_detected': session.had_speech}


class SpeechSession:
    def __init__(self, engine):
        self.engine = engine
        with engine.lock:
            self.stream = engine.recognizer.create_stream()
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = str(engine.assets/'models/silero_vad.onnx')
        cfg.silero_vad.min_silence_duration = .8
        cfg.silero_vad.min_speech_duration = .2
        cfg.silero_vad.max_speech_duration = 120
        cfg.sample_rate = 16000
        cfg.num_threads = 1
        self.vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=130)
        self.pending = np.empty(0, dtype=np.float32)
        self.had_speech = False
        self.ended = False
        self.finished = False
        self.seconds = 0
        self.text = ''

    def feed(self, samples):
        if self.finished:
            return self.text
        samples = np.asarray(samples, dtype=np.float32)
        if not np.isfinite(samples).all():
            raise ValueError('Invalid audio')
        self.seconds += len(samples)/16000
        self.pending = np.concatenate((self.pending, samples))
        while len(self.pending) >= 512:
            self.vad.accept_waveform(self.pending[:512])
            self.pending = self.pending[512:]
            self.had_speech |= self.vad.is_speech_detected() or not self.vad.empty()
            if not self.vad.empty():
                self.ended = True
                while not self.vad.empty():
                    self.vad.pop()
        with self.engine.lock:
            self.stream.accept_waveform(16000, samples)
            while self.engine.recognizer.is_ready(self.stream):
                self.engine.recognizer.decode_stream(self.stream)
            self.text = self.engine.recognizer.get_result(self.stream)
        return self.text if self.had_speech else ''

    def finish(self):
        if self.finished:
            return self.text
        self.feed(np.zeros(3200, dtype=np.float32))
        self.vad.flush()
        self.had_speech |= not self.vad.empty()
        with self.engine.lock:
            self.stream.input_finished()
            while self.engine.recognizer.is_ready(self.stream):
                self.engine.recognizer.decode_stream(self.stream)
            self.text = self.engine.recognizer.get_result(self.stream) if self.had_speech else ''
        self.finished = True
        return self.text

