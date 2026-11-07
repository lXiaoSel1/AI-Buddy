"""Pinned Breeze BF16 / CFG 4 synthesis over AI Buddy private pipes."""
import base64
import contextlib
import json
import os
import sys
import time
import uuid
from cadence import with_cadence

from worker_protocol import directory, reference, speech, worker, WorkerError

runtime = tokenizer = model = codec = None


def generate(text, instruction, ref):
    import numpy as np
    from breeze_infer.runtime import set_all_seeds
    from breeze_infer.templates import prepare_inputs, get_template, select_template_name
    request = {'id':str(uuid.uuid4()), 'text':text, 'speaker':'S0',
               'instruction':'保持参考音色和普通话发音。'+with_cadence(text,instruction),
               'ref_audio_path':str(ref[0]), 'ref_text':ref[1]}
    set_all_seeds(42)
    started = time.perf_counter()
    inputs = prepare_inputs(tokenizer, codec, model, [request], get_template(select_template_name(request)),
                            guidance_scale=4., guidance_scale_ref=None, guidance_scale_ins=None)
    first = None
    samples = 0
    with contextlib.closing(runtime.iter_audio_chunks(inputs, request_id=request['id'], seed=42)) as chunks:
        for chunk in chunks:
            audio = np.asarray(chunk.audio).reshape(-1)
            if not np.isfinite(audio).all():
                raise RuntimeError('Non-finite PCM')
            if not len(audio):
                continue
            now = time.perf_counter() - started
            first = first if first is not None else now
            samples += len(audio)
            pcm = (np.clip(audio, -1, 1)*32767).astype('<i2').tobytes()
            yield {'type':'pcm', 'pcm':base64.b64encode(pcm).decode(), 'sample_rate':runtime.sample_rate, 'elapsed':now}
    elapsed = time.perf_counter() - started
    duration = samples/runtime.sample_rate
    if duration == 0:
        raise RuntimeError('Breeze returned no audio')
    yield {'type':'done', 'reference_sha256':ref[3], 'reference_text_sha256':ref[4], 'first_pcm_seconds':first, 'generation_seconds':elapsed, 'audio_seconds':duration, 'rtf':elapsed/duration}


def load(request):
    global runtime, tokenizer, model, codec
    engine = directory(request, 'root')
    assets = directory(request, 'assetRoot')
    cache = directory(request, 'cacheRoot')
    sys.path.insert(0, str(engine))
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', HF_HOME=str(cache))
    import torch
    from breeze_infer.runtime import load_runtime, update_generation_config_for_breeze
    from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig
    if not torch.cuda.is_available():
        raise WorkerError('VOICE_CUDA_REQUIRED', 'Breeze 当前需要 Windows NVIDIA CUDA')
    if torch.cuda.mem_get_info()[0] < 9.5 * 1024**3:
        raise WorkerError('VOICE_GPU_MEMORY', 'Breeze 当前需要至少 9.5 GiB 空闲显存')
    started = time.perf_counter()
    tokenizer, model, codec = load_runtime(assets/'checkpoints', device='cuda:0', attn_implementation='eager')
    update_generation_config_for_breeze(model)
    config = FastStreamingConfig(max_new_tokens=750, max_seq_len=2048, fast_all=None, fast_backbone_decode=True)
    runtime = FastBreezeStreamingRuntime(model, codec, config, tokenizer=tokenizer)
    runtime._ensure_graphs(2, 4.)
    depth = runtime._depth_decoder_graph
    depth.bucket_sizes = [2]
    depth.capture(num_warmup=3)
    depth.no_graph = False
    return {'type':'result', 'state':'ready', 'load_seconds':time.perf_counter()-started}


def handle(request):
    if request['op'] == 'initialize' and runtime is None:
        yield load(request)
    elif request['op'] == 'speak' and runtime is not None:
        text, instruction = speech(request)
        ref = reference(request)
        yield from generate(text, instruction, ref)
    else:
        raise WorkerError('VOICE_TTS_NOT_READY', 'Breeze 尚未准备就绪')


if __name__ == '__main__':
    worker(handle)

