#!/usr/bin/env python3
from __future__ import annotations

import asyncio, json, time, logging, socket, sys, uvicorn
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from PIL import Image
import torchvision.transforms as transforms

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from huggingface_hub import hf_hub_download
import onnxruntime as ort

# -----------------------------------------------------------------------------
# Logging — stderr only. Stdout is reserved for the port handshake.
# -----------------------------------------------------------------------------

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger('camie')

# -----------------------------------------------------------------------------
# Model state — populated by load_model() once at lifespan startup.
# -----------------------------------------------------------------------------

GPU_BATCH_SIZE      = 8
HF_REPO             = "Camais03/camie-tagger-v2"
ONNX_FILENAME       = "camie-tagger-v2.onnx"
METADATA_FILENAME   = "camie-tagger-v2-metadata.json"

_session            : Optional[ort.InferenceSession] = None
_input_name         : Optional[str] = None
_idx_to_tag         : dict[str, str] = {}
_tag_to_category    : dict[str, str] = {}
_img_size           : int = 512
_device             : str = "cpu"

# ImageNet normalization. Constant — built once at module load.
_IMAGENET_TRANSFORM = transforms.Compose([
    transforms.ToTensor(),
    transforms.Normalize(
        mean=[0.485, 0.456, 0.406],
        std=[0.229, 0.224, 0.225],
    ),
])

# Pad color matches the ImageNet mean as an integer RGB triple. Using
# the model's training-time padding color avoids "the model thinks the
# pad is content" artifacts on non-square images.
_PAD_COLOR = (124, 116, 104)


def load_model() -> None:
    """Download (if needed), load the ONNX model and tag metadata."""
    global _session, _input_name, _idx_to_tag, _tag_to_category, _img_size, _device

    log.info(f"Locating Camie v2 files (repo: {HF_REPO})...")
    # hf_hub_download is a no-op on cache hit, so subsequent boots are fast.
    model_path = hf_hub_download(repo_id=HF_REPO, filename=ONNX_FILENAME)
    metadata_path = hf_hub_download(repo_id=HF_REPO, filename=METADATA_FILENAME)
    log.info(f"Model file:    {model_path}")
    log.info(f"Metadata file: {metadata_path}")

    # Load the tag dictionary. ~70k entries, ~8MB of JSON — one-time cost.
    log.info("Loading tag metadata...")
    with open(metadata_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)
    try:
        ds_info = meta['dataset_info']
        tag_mapping = ds_info['tag_mapping']
        _idx_to_tag = tag_mapping['idx_to_tag']
        _tag_to_category = tag_mapping['tag_to_category']
        _img_size = meta['model_info']['img_size']
        total_tags = ds_info['total_tags']
    except KeyError as e:
        raise RuntimeError(f"Metadata structure unexpected, missing key: {e}")
    log.info(f"Metadata loaded: {total_tags} tags, img_size={_img_size}")

    # Pick execution providers. CUDA when the GPU build of ORT can see one,
    # CPU as the always-present fallback. ORT's provider auto-selection
    # picks the first available in the list at session-creation time.
    providers = []
    if ort.get_device() == 'GPU':
        providers.append('CUDAExecutionProvider')
    providers.append('CPUExecutionProvider')
    log.info(f"Configured providers: {providers}")

    _session = ort.InferenceSession(model_path, providers=providers)
    active_provider = _session.get_providers()[0]
    _device = 'cuda' if active_provider == 'CUDAExecutionProvider' else 'cpu'
    log.info(f"Active provider: {active_provider} (device: {_device})")

    # Cache the input name — the ONNX graph only has one input but its
    # name isn't a hardcoded constant; ask the session.
    _input_name = _session.get_inputs()[0].name

    log.info("Camie v2 ready.")
    _warmup()

def unload_model() -> None:
    """Release the ONNX session and free VRAM. Called on shutdown."""
    global _session, _input_name
    log.info("Unloading model...")
    _session = None
    _input_name = None
    # ORT doesn't expose an explicit VRAM-release API; setting the session
    # to None lets Python's GC reclaim it. For CUDA users, the process
    # exit is what actually frees VRAM — which is fine, since we only
    # get here on shutdown.

def _preprocess_image(image_path: str) -> np.ndarray:
    """Resize-with-aspect, pad with ImageNet mean color, ImageNet normalize.

    Matches the reference inference script from the HF repo. Returns a
    numpy array of shape (1, 3, img_size, img_size), dtype float32.
    """
    with Image.open(image_path) as img:
        if img.mode != 'RGB':
            img = img.convert('RGB')

        width, height = img.size
        # Scale the longer edge to img_size, preserve aspect ratio.
        if width >= height:
            new_width = _img_size
            new_height = int(round(_img_size * height / width))
        else:
            new_height = _img_size
            new_width = int(round(_img_size * width / height))

        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

        # Center-pad to the model's square input size.
        canvas = Image.new('RGB', (_img_size, _img_size), _PAD_COLOR)
        paste_x = (_img_size - new_width) // 2
        paste_y = (_img_size - new_height) // 2
        canvas.paste(img, (paste_x, paste_y))

        tensor = _IMAGENET_TRANSFORM(canvas)  # (3, H, W)
        return tensor.unsqueeze(0).numpy()    # (1, 3, H, W)

def _sigmoid(x: np.ndarray) -> np.ndarray:
    out = np.empty_like(x)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    e = np.exp(x[~pos])
    out[~pos] = e / (1.0 + e)
    return out

def _run_batch(image_paths: list[str], threshold: float) -> list[list[dict]]:
    """One GPU batch. Caller chunks by GPU_BATCH_SIZE."""
    if _session is None:
        raise RuntimeError("Model not loaded")
    if not image_paths:
        return []

    # Preprocess each, strip batch dim, stack into (N, 3, H, W).
    arrays = [_preprocess_image(p)[0] for p in image_paths]
    batch_input = np.stack(arrays, axis=0)

    outputs = _session.run(None, {_input_name: batch_input})
    logits = outputs[1] if len(outputs) >= 2 else outputs[0]
    probs = _sigmoid(logits)  # (N, num_tags)

    results = []
    for row in probs:
        indices = np.where(row >= threshold)[0]
        per_image = []
        for idx in indices:
            idx_str = str(int(idx))
            tag_name = _idx_to_tag.get(idx_str)
            if tag_name is None:
                continue
            per_image.append({
                'tag': tag_name,
                'score': float(row[idx]),
                'category': _tag_to_category.get(tag_name, 'general'),
            })
        results.append(per_image)
    return results


def tag_batch(image_paths: list[str], threshold: float = 0.0) -> list[list[dict]]:
    """Batched inference. Internally chunks the request by GPU_BATCH_SIZE
    so the caller can pass an arbitrary-sized list without worrying about
    VRAM. Throughput improves over the old per-image loop because each
    chunk amortizes one CUDA dispatch across N images.

    Caller (Node wrapper) sends one HTTP request per Node-level chunk;
    we shred that further into GPU-sized sub-batches here.
    """
    if not image_paths:
        return []
    out = []
    for i in range(0, len(image_paths), GPU_BATCH_SIZE):
        out.extend(_run_batch(image_paths[i:i + GPU_BATCH_SIZE], threshold))
    return out


def _warmup() -> None:
    """Pre-trigger CUDA kernel JIT for the batch sizes we'll actually
    use. First inference on a fresh session pays ~10s per shape; doing
    it here means /health blocks for an extra ~15s on first boot but
    every subsequent inference runs at steady state.
    """
    log.info("Warming up CUDA kernels...")
    t0 = time.perf_counter()
    for n in (1, GPU_BATCH_SIZE):
        dummy = np.zeros((n, 3, _img_size, _img_size), dtype=np.float32)
        _session.run(None, {_input_name: dummy})
    log.info(f"Warmup complete in {time.perf_counter() - t0:.1f}s")

# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Loading happens BEFORE uvicorn binds — so /health succeeding always
    # means the model is loaded. No extra readiness flag needed.
    load_model()
    yield
    # uvicorn calls this on SIGTERM. unload_model() frees the session.
    unload_model()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


class TagRequest(BaseModel):
    image_paths: list[str] = Field(..., min_length=1)
    threshold: float = 0.0
    categories: Optional[list[str]] = None  # None = all


class TagResponse(BaseModel):
    results: list[list[dict]]


@app.get("/health")
async def health():
    return {"status": "ready", "device": _device}


@app.post("/tag", response_model=TagResponse)
async def tag(req: TagRequest):
    try:
        # asyncio.to_thread keeps the event loop responsive during long
        # batches. ONNX Runtime releases the GIL during inference, so
        # this is real parallelism against any concurrent health checks.
        raw = await asyncio.to_thread(tag_batch, req.image_paths, req.threshold)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=f"Image not found: {e.filename}")
    except Exception as e:
        log.exception("Inference failed")
        raise HTTPException(status_code=500, detail=str(e))

    # Category filter — only thing left to do after tag_batch already
    # applied the threshold.
    if req.categories:
        cats = set(req.categories)
        raw = [[t for t in tags if t['category'] in cats] for tags in raw]

    return {"results": raw}


# -----------------------------------------------------------------------------
# Port handshake + entry point
# -----------------------------------------------------------------------------

def pick_free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    port = pick_free_port()
    # Handshake: parent reads PORT=<n> from stdout, then talks HTTP.
    # flush=True is critical — without it the parent waits forever for
    # our first line to flush from the default buffer.
    print(f"PORT={port}", flush=True)

    uvicorn.run(
        app,
        host='127.0.0.1',
        port=port,
        log_level='warning',
        access_log=False,
    )


if __name__ == '__main__':
    main()
