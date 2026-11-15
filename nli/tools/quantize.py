"""Weight-only 8-bit quantization of an NLI cross-encoder's ONNX graph.

    python quantize.py <model.onnx (fp32)> <model_quantized.onnx>

Why this recipe (measured on DeBERTa-v3-large against Speck's qualification corpus, 198 cases):
  - dynamic int8 (what onnx/model_quantized.onnx on Hugging Face is): 104/198 agree with fp32.
    Per-tensor uint8 activations wreck DeBERTa's disentangled attention; per-channel weights or
    leaving activation x activation MatMuls in fp32 don't fix it (106-111/198).
  - weight-only 8-bit (MatMulNBits, block 128, symmetric) with accuracy_level 4 (int8 compute on
    128-value activation blocks): 198/198, at ~1.2x fp32's CPU latency. Embeddings stay fp32:
    fp16 embeddings save 0.26 GB but flipped one case.
"""
import sys

import onnx
from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer

source, target = sys.argv[1], sys.argv[2]
config = DefaultWeightOnlyQuantConfig(
    block_size=128, is_symmetric=True, bits=8, accuracy_level=4,
    op_types_to_quantize=("MatMul",), quant_axes=(("MatMul", 0),),
)
quantizer = MatMulNBitsQuantizer(onnx.load(source), algo_config=config)
quantizer.process()
quantizer.model.save_model_to_file(target, use_external_data_format=False)
print(f"wrote {target}")
