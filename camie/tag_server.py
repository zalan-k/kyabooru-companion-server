#!/usr/bin/env python3
"""
Camie v2 tagger sidecar — long-lived HTTP service.

Lifecycle: parent process (Node, server.js) spawns us with no arguments.
We pick a free port on 127.0.0.1, print "PORT=<n>" on our first stdout
line as a handshake, then load the model and start serving. Once the
lifespan startup completes, uvicorn binds the port, so a successful
/health response is a definitive readiness signal.

Model: Camais03/camie-tagger-v2 from HuggingFace, loaded as ONNX via
onnxruntime. Two files needed (auto-downloaded on first run via
huggingface_hub):
  - camie-tagger-v2.onnx                    (789 MB, the weights)
  - camie-tagger-v2-metadata.json           (7.7 MB, the tag dictionary)
Both cache to ~/.cache/huggingface/hub by default — first cold start
will be slow, subsequent boots are fast.

Endpoints:
  GET  /health
       Returns {"status": "ready", "device": "cuda"|"cpu"}.

  POST /tag
       Body: {
         "image_paths": ["abs/path/1.jpg", ...],
         "threshold":   0.35,                  # optional, default 0.0
         "categories":  ["general", "meta"]    # optional, default all
       }
       Returns: {
         "results": [
           [{"tag": "1girl", "score": 0.91, "category": "general"}, ...],
           ...
         ]
       }
       Order matches image_paths. Each list is already filtered by
       threshold + categories. Filtering happens server-side to keep
       network traffic small when the response would otherwise include
       thousands of near-zero scores per image.

Logs go to stderr — the Node wrapper prefixes them with [camie] before
re-emitting. The first stdout line is the port handshake; everything
else stays off stdout so the handshake stays unambiguous.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import sys
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from PIL import Image
import torchvision.transforms as transforms

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn

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

HF_REPO = "Camais03/camie-tagger-v2"
ONNX_FILENAME = "camie-tagger-v2.onnx"
METADATA_FILENAME = "camie-tagger-v2-metadata.json"

_session: Optional[ort.InferenceSession] = None
_input_name: Optional[str] = None
_idx_to_tag: dict[str, str] = {}
_tag_to_category: dict[str, str] = {}
_img_size: int = 512
_device: str = "cpu"

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
    """Numerically stable sigmoid. The logits returned by the model can
    occasionally hit values where naive sigmoid would overflow."""
    out = np.empty_like(x)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    e = np.exp(x[~pos])
    out[~pos] = e / (1.0 + e)
    return out


def tag_one(image_path: str, threshold: float = 0.0) -> list[dict]:
    """Run inference on one image. Returns tags with score >= threshold.

    The threshold filter happens here (not in the /tag handler) to avoid
    allocating dicts for ~70k near-zero predictions per image.
    """
    if _session is None:
        raise RuntimeError("Model not loaded")

    img_array = _preprocess_image(image_path)
    outputs = _session.run(None, {_input_name: img_array})

    # The model emits initial_predictions, refined_predictions,
    # selected_candidates. Refined is the higher-quality output and what
    # the reference script uses. Fall back to outputs[0] if only one is
    # present (defensive).
    logits = outputs[1] if len(outputs) >= 2 else outputs[0]
    probs = _sigmoid(logits)[0]  # drop the batch dim

    # Vectorize the threshold filter — much faster than a Python loop
    # over 70k indices when threshold rejects almost everything.
    indices = np.where(probs >= threshold)[0]
    out = []
    for idx in indices:
        idx_str = str(int(idx))
        tag_name = _idx_to_tag.get(idx_str)
        if tag_name is None:
            continue
        out.append({
            'tag': tag_name,
            'score': float(probs[idx]),
            'category': _tag_to_category.get(tag_name, 'general'),
        })
    return out


def tag_batch(image_paths: list[str], threshold: float = 0.0) -> list[list[dict]]:
    """Sequential per-image inference.

    Note on batching: the ONNX model probably supports a dynamic batch
    dimension (it's a ViT with a standard input shape), and stacking N
    images into one inference call would amortize GPU dispatch overhead.
    We're not doing that here — the Node wrapper already coalesces HTTP
    requests, and for the staging-manager workload (mostly trickle, with
    occasional 30k backfills) sequential is good enough. If the backfill
    becomes a perf bottleneck, this is the place to add true batching.
    """
    return [tag_one(p, threshold) for p in image_paths]


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
    """Ask the OS for a free TCP port on the loopback interface.

    Small TOCTOU window between us closing this socket and uvicorn
    binding it, but on loopback with no other process racing for ports
    it's fine in practice — and the alternative (port scan + retry)
    is uglier.
    """
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
