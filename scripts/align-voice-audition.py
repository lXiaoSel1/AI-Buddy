"""Derive matched short comparison references without editing authorized originals."""
import argparse
import difflib
import hashlib
import json
import os
import unicodedata
import wave
from math import gcd
from pathlib import Path

import numpy as np
import sherpa_onnx
from scipy.signal import resample_poly


def normal(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).lower() if c.isalnum())


def recognize(recognizer, samples):
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, np.concatenate((samples, np.zeros(4800, dtype=np.float32))))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    return recognizer.get_result_all(stream)


def timesteps(result):
    chars, times = [], []
    for token, at in zip(result.tokens, result.timestamps):
        for char in normal(token):
            chars.append(char)
            times.append(at)
    return ''.join(chars), times


def find_prefix(recognizer, audio, source_rate, text):
    divisor = gcd(source_rate, 16000)
    mono = audio.astype(np.float32) / 32768
    pcm = resample_poly(mono, 16000 // divisor, source_rate // divisor)
    transcript = normal(text)
    predicted, times = timesteps(recognize(recognizer, pcm))
    matcher = difflib.SequenceMatcher(None, transcript, predicted, autojunk=False)
    if matcher.ratio() < 0.77 or len(times) != len(predicted):
        raise ValueError(f'full transcript alignment {matcher.ratio():.2f} is too weak')
    candidates = []
    for pair in matcher.get_matching_blocks():
        for offset in range(2, pair.size - 1):
            source_boundary = pair.a + offset
            next_token = pair.b + offset
            # Consecutive duplicate timestamps are the same recognizer token.
            previous, next_at = times[next_token - 1], times[next_token]
            if previous >= next_at or not 3.5 <= next_at <= 9.65:
                continue
            lo = max(3.4, previous + min(.08, (next_at - previous) / 2))
            hi = min(9.7, next_at + .04)
            window = max(1, source_rate // 100)
            trials = np.arange(round(lo * source_rate), round(hi * source_rate), window)
            if not len(trials):
                continue
            energy = np.asarray([np.mean(np.square(mono[max(0, cut-window):cut+window])) for cut in trials])
            winner = int(np.argmin(energy))
            candidates.append((float(energy[winner]) + abs(float(trials[winner])/source_rate - 7.5) * .0001,
                               int(trials[winner]), source_boundary))
    for _, cut, source_boundary in sorted(candidates):
        prefix = transcript[:source_boundary]
        recognized = normal(recognize(recognizer, pcm[:round(cut * 16000 / source_rate)]).text)
        confirmation = difflib.SequenceMatcher(None, prefix, recognized, autojunk=False).ratio()
        if confirmation < 0.86 or len(recognized) > len(prefix) + 1 or len(recognized) < len(prefix) - 2:
            continue
        count = 0
        for end, char in enumerate(text, start=1):
            count += len(normal(char))
            if count >= source_boundary:
                return cut, text[:end], matcher.ratio(), confirmation
    raise ValueError('no confirmed spoken prefix in 3–10 seconds')


def atomic_json(path, value):
    staging = path.with_suffix('.json.partial')
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    os.replace(staging, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--samples', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--asr-model', type=Path, required=True)
    parser.add_argument('--role', action='append', help='Replace only named references in the same source revision')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'comparison').mkdir(exist_ok=True)
    source_path = args.samples/'VOICE-SAMPLES.json'
    data = json.loads(source_path.read_text(encoding='utf-8-sig'))
    asr = args.asr_model
    engine = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(asr/'tokens.txt'), encoder=str(asr/'encoder-epoch-99-avg-1.int8.onnx'),
        decoder=str(asr/'decoder-epoch-99-avg-1.onnx'), joiner=str(asr/'joiner-epoch-99-avg-1.int8.onnx'),
        num_threads=2, sample_rate=16000, decoding_method='greedy_search', provider='cpu')
    source_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
    reference_file = args.out/'REFERENCES.json'
    if reference_file.is_file():
        report = json.loads(reference_file.read_text(encoding='utf-8-sig'))
        if report.get('sourceManifestSHA') != source_sha:
            parser.error('Existing reference index belongs to a different source revision')
    else:
        report = {'schemaVersion': 1, 'sourceManifestSHA': source_sha, 'entries': {}}
    if args.role and set(args.role) - {role['id'] for role in data['roles']}:
        parser.error('Unknown role in --role')
    for role in data['roles']:
        role_id = role['id']
        if args.role and role_id not in args.role:
            continue
        row = data['entries'][role_id+':calm']
        try:
            file = args.samples/row['file']
            source_sha = hashlib.sha256(file.read_bytes()).hexdigest()
            if not row.get('authorized') or source_sha != row['sha256'] or file.stat().st_size != row['bytes']:
                raise ValueError('reference not authorized or does not match pinned original')
            with wave.open(str(file), 'rb') as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                    raise ValueError('expected mono PCM16 WAV')
                rate = wav.getframerate()
                audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
            cut, text, full_ratio, prefix_ratio = find_prefix(engine, audio, rate, row['text'])
            clipped = audio[:cut].copy()
            fade = min(cut, round(rate * .014))
            clipped[-fade:] = clipped[-fade:] * np.linspace(1, 0, fade)
            file = args.out/'comparison'/(role_id+'-calm.wav')
            with wave.open(str(file), 'wb') as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(clipped.tobytes())
            report['entries'][role_id] = {
                'sourceSHA':source_sha, 'file':file.relative_to(args.out).as_posix(),
                'sha256':hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes':file.stat().st_size,
                'text':text, 'language':row['language'], 'durationMs':round(cut*1000/rate),
                'method':'sherpa-onnx-aligned-prefix', 'fullMatch':round(full_ratio,3), 'prefixMatch':round(prefix_ratio,3),
            }
            print(role_id, report['entries'][role_id]['durationMs'], report['entries'][role_id]['prefixMatch'], flush=True)
        except ValueError as exc:
            report['entries'][role_id] = {'error':str(exc)}
            print(role_id, str(exc), flush=True)
        atomic_json(args.out/'REFERENCES.json', report)


if __name__ == '__main__':
    main()

