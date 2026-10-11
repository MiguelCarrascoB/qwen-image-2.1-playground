#!/usr/bin/env python3
"""Build a ComfyUI-native Qwen-Image-2.1 text encoder from AtomicChat's
abliterated ("uncensored") Qwen3-VL-8B GGUF.

Why this exists: AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF ships the
encoder's language model only (vision tower lives in a separate mmproj), built
for stable-diffusion.cpp. ComfyUI recognises a Qwen-Image-2.1 encoder
(TEModel.QWEN3VL_8B) only when the vision-tower keys are present, and
ComfyUI-GGUF does not attach an mmproj for qwen3vl -- so the GGUF on its own is
detected as a plain Qwen3-8B and routed to the wrong encoder.

This script writes one BF16 safetensors file in the exact layout of
Comfy-Org's qwen3vl_8b_bf16.safetensors:
  * every language-model tensor (embeddings, 36 blocks, final norm, lm_head)
    dequantized from the abliterated GGUF, and
  * the unmodified vision tower (model.visual.*) copied from a stock Comfy-Org
    encoder you already have (qwen3vl_8b_w4a8 / int8_convrot / bf16 -- all keep
    the vision tower in BF16).
Load the result with the core CLIPLoader, type "qwen_image".

Run it with the ComfyUI venv's Python (it needs gguf, safetensors, torch):
  ComfyUI/.venv/bin/python scripts/build_uncensored_encoder.py \
      --gguf   ComfyUI/models/text_encoders/Qwen-Image-2.1-Turbo-Abliterated-Uncensored-Q8_0.gguf \
      --vision ComfyUI/models/text_encoders/qwen3vl_8b_w4a8.safetensors \
      --out    ComfyUI/models/text_encoders/qwen3vl_8b_abliterated_bf16.safetensors

Tensors are streamed one at a time (the 17.5 GB output is never held in
memory); a run takes under a minute and ~10 GB RSS, mostly memory-mapped input.
"""
import argparse
import json
import os
import struct
import sys

import numpy as np
import torch
from gguf import GGUFReader
from gguf.quants import dequantize
from safetensors import safe_open

N_LAYERS = 36
HIDDEN = 4096
VOCAB = 151936

# llama.cpp tensor names -> HF/Comfy names (same table ComfyUI-GGUF uses for
# llama-family text encoders; order matters: "attn_q_norm." before "attn_q").
NAME_MAP = [
    ("blk.", "model.layers."),
    ("attn_norm", "input_layernorm"),
    ("attn_q_norm.", "self_attn.q_norm."),
    ("attn_k_norm.", "self_attn.k_norm."),
    ("attn_q", "self_attn.q_proj"),
    ("attn_k", "self_attn.k_proj"),
    ("attn_v", "self_attn.v_proj"),
    ("attn_output", "self_attn.o_proj"),
    ("ffn_up", "mlp.up_proj"),
    ("ffn_down", "mlp.down_proj"),
    ("ffn_gate", "mlp.gate_proj"),
    ("ffn_norm", "post_attention_layernorm"),
    ("token_embd", "model.embed_tokens"),
    ("output_norm", "model.norm"),
    ("output.weight", "lm_head.weight"),
]

LAYER_KEYS = [
    "input_layernorm.weight", "post_attention_layernorm.weight",
    "self_attn.q_proj.weight", "self_attn.k_proj.weight", "self_attn.v_proj.weight",
    "self_attn.o_proj.weight", "self_attn.q_norm.weight", "self_attn.k_norm.weight",
    "mlp.gate_proj.weight", "mlp.up_proj.weight", "mlp.down_proj.weight",
]


def hf_name(name):
    for src, dst in NAME_MAP:
        name = name.replace(src, dst)
    return name


def expected_lm_keys():
    keys = {"model.embed_tokens.weight", "model.norm.weight", "lm_head.weight"}
    for i in range(N_LAYERS):
        keys.update(f"model.layers.{i}.{k}" for k in LAYER_KEYS)
    return keys


def field_str(reader, key):
    f = reader.fields.get(key)
    if f is None:
        return None
    return bytes(f.parts[f.data[0]]).decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gguf", required=True, help="abliterated Qwen3-VL-8B GGUF (any quant)")
    ap.add_argument("--vision", required=True, help="stock Comfy-Org qwen3vl_8b_*.safetensors (vision tower source)")
    ap.add_argument("--out", required=True, help="output .safetensors (in models/text_encoders/)")
    args = ap.parse_args()

    reader = GGUFReader(args.gguf)
    arch = field_str(reader, "general.architecture")
    if arch not in ("qwen3vl", "qwen3"):
        sys.exit(f"Unexpected GGUF architecture {arch!r} (want qwen3vl)")

    # --- plan: (name, shape, source) for every output tensor, before writing --
    lm = {}
    for t in reader.tensors:
        name = hf_name(t.name)
        shape = [int(x) for x in reversed(t.shape.tolist())]  # ggml ne -> row-major
        lm[name] = (shape, t)
    missing = expected_lm_keys() - lm.keys()
    extra = lm.keys() - expected_lm_keys()
    if missing or extra:
        sys.exit(f"GGUF tensors don't match Qwen3-VL-8B.\n missing: {sorted(missing)[:10]}\n extra: {sorted(extra)[:10]}")
    if lm["model.embed_tokens.weight"][0] != [VOCAB, HIDDEN] or lm["lm_head.weight"][0] != [VOCAB, HIDDEN]:
        sys.exit("Unexpected embedding / lm_head shape")

    vis_file = safe_open(args.vision, framework="pt")
    vision = {}
    for k in vis_file.keys():
        if not k.startswith("model.visual."):
            continue  # stock LM tensors may be int8/w4a8 packed -- never copy them
        sl = vis_file.get_slice(k)
        if sl.get_dtype() != "BF16":
            sys.exit(f"Vision tensor {k} is {sl.get_dtype()}, expected BF16")
        vision[k] = list(sl.get_shape())
    if "model.visual.deepstack_merger_list.0.norm.weight" not in vision:
        sys.exit("No Qwen3-VL vision tower (deepstack mergers) found in --vision file")

    plan = [(k, lm[k][0], "lm") for k in sorted(lm)] + [(k, vision[k], "vis") for k in sorted(vision)]

    # --- header --------------------------------------------------------------
    header, offset = {}, 0
    for name, shape, _ in plan:
        nbytes = int(np.prod(shape)) * 2
        header[name] = {"dtype": "BF16", "shape": shape, "data_offsets": [offset, offset + nbytes]}
        offset += nbytes
    header["__metadata__"] = {
        "format": "pt",
        "source": os.path.basename(args.gguf) + " + model.visual.* from " + os.path.basename(args.vision),
    }
    hbytes = json.dumps(header, separators=(",", ":")).encode()
    hbytes += b" " * (-len(hbytes) % 8)

    # --- stream tensors ------------------------------------------------------
    tmp = args.out + ".part"
    with open(tmp, "wb") as f:
        f.write(struct.pack("<Q", len(hbytes)))
        f.write(hbytes)
        for i, (name, shape, src) in enumerate(plan, 1):
            if src == "lm":
                t = lm[name][1]
                arr = dequantize(t.data, t.tensor_type).reshape(shape)
                ten = torch.from_numpy(np.ascontiguousarray(arr, dtype=np.float32)).to(torch.bfloat16)
            else:
                ten = vis_file.get_tensor(name).to(torch.bfloat16)
                if list(ten.shape) != shape:
                    sys.exit(f"Shape mismatch for {name}")
            f.write(ten.contiguous().view(torch.uint16).numpy().tobytes())
            if i % 50 == 0 or i == len(plan):
                print(f"  {i}/{len(plan)} tensors", flush=True)
    os.replace(tmp, args.out)
    print(f"Wrote {args.out} ({os.path.getsize(args.out) / 1e9:.2f} GB, {len(plan)} tensors)")


if __name__ == "__main__":
    main()
