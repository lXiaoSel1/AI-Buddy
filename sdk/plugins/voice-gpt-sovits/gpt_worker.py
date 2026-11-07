"""Pinned GPT-SoVITS V5 Turbo synthesis over AI Buddy private pipes."""
import base64
import contextlib
import io
import json
import os
import sys
import time

from worker_protocol import directory, reference, speech, worker, WorkerError

state = {}
model = None


def generate(text, ref):
    import numpy as np
    import psutil
    import torch
    request = {'text':text, 'text_lang':'zh', 'ref_audio_path':str(ref[0]),
               'prompt_text':ref[1], 'prompt_lang':ref[2], 'top_k':15, 'top_p':1.0, 'temperature':1.0,
               'text_split_method':'cut3', 'batch_size':1, 'split_bucket':False,
               'return_fragment':True, 'streaming_mode':False, 'fragment_interval':0.5,
               'speed_factor':1.0, 'seed':42, 'parallel_infer':False, 'repetition_penalty':1.35,
               'sample_steps':4, 'cfg_rate':0.0, 'use_cuda_graph':False, 'use_flash_attention':False}
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    first = None
    duration = 0.0
    samples = 0
    has_voice = False
    # Upstream prints the full target text; keep it out of persistent service logs.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.closing(model.run(request)) as chunks:
        for sample_rate, audio in chunks:
            arr = np.asarray(audio).reshape(-1)
            if not np.isfinite(arr).all():
                raise RuntimeError('Non-finite PCM')
            if not arr.size:
                continue
            if np.issubdtype(arr.dtype, np.floating):
                arr = np.clip(arr, -1, 1)*32767
            arr = arr.astype('<i2')
            state['sample_rate'] = sample_rate
            voiced = bool(np.any(arr))
            has_voice = has_voice or voiced
            elapsed = time.perf_counter()-started
            if first is None and voiced:
                first = elapsed
            duration += len(arr)/sample_rate
            samples += len(arr)
            yield {'type':'pcm', 'pcm':base64.b64encode(arr.tobytes()).decode(), 'sample_rate':sample_rate, 'elapsed':elapsed}
    if not has_voice or not samples:
        raise RuntimeError('GPT-SoVITS returned no audible audio')
    elapsed = time.perf_counter()-started
    state.update(reserved_gib=round(torch.cuda.memory_reserved()/1024**3,3), process_rss_gib=round(psutil.Process().memory_info().rss/1024**3,3))
    yield {'type':'done', 'reference_sha256':ref[3], 'reference_text_sha256':ref[4], 'first_pcm_seconds':first, 'generation_seconds':elapsed, 'audio_seconds':duration, 'rtf':elapsed/duration,
           'torch_peak_allocated_gib':round(torch.cuda.max_memory_allocated()/1024**3,3),
           'torch_peak_reserved_gib':round(torch.cuda.max_memory_reserved()/1024**3,3), 'process_rss_gib':state['process_rss_gib']}


def load(request):
    global model
    engine = directory(request, 'root')
    assets = directory(request, 'assetRoot')
    cache = directory(request, 'cacheRoot')
    os.chdir(engine)
    sys.path[:0] = [str(engine), str(engine/'GPT_SoVITS')]
    os.environ.update(HF_HOME=str(cache), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', version='v5turbo')
    import torch
    from TTS_infer_pack.TTS import TTS, TTS_Config
    if not torch.cuda.is_available():
        raise WorkerError('VOICE_CUDA_REQUIRED', 'GPT-SoVITS 当前需要 Windows NVIDIA CUDA')
    if torch.cuda.mem_get_info()[0] < 4 * 1024**3:
        raise WorkerError('VOICE_GPU_MEMORY', 'GPT-SoVITS 当前需要至少 4 GiB 空闲显存')
    started = time.perf_counter()
    pre = assets / 'GPT_SoVITS/pretrained_models'
    config = TTS_Config({'custom':{'device':'cuda', 'is_half':True, 'version':'v5turbo',
        't2s_weights_path':str(pre/'s1v3.ckpt'), 'vits_weights_path':str(pre/'gsv-v5-pretrained/s2Gv5turbo.pth'),
        'bert_base_path':str(pre/'chinese-roberta-wwm-ext-large'), 'cnhuhbert_base_path':str(pre/'chinese-hubert-base')}})
    config.configs_path = str(cache/'gpt-runtime.yaml')
    model = TTS(config)
    return {'type':'result', 'state':'ready', 'load_seconds':time.perf_counter()-started}


def handle(request):
    if request['op'] == 'initialize' and model is None:
        yield load(request)
    elif request['op'] == 'speak' and model is not None:
        text, _ = speech(request)
        ref = reference(request)
        yield from generate(text, ref)
    else:
        raise WorkerError('VOICE_TTS_NOT_READY', 'GPT-SoVITS 尚未准备就绪')


if __name__ == '__main__':
    worker(handle)

