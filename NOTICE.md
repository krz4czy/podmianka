Podmianka is a small static page. The swap itself follows the FaceFusion image pipeline
(detection, 5-point alignment, embedding, INSwapper, paste-back). It is not a copy of the
FaceFusion application.

Attribution
- FaceFusion, Henry Ruhs — pipeline and preprocessing. License: OpenRAIL-AS.
  https://github.com/facefusion/facefusion
  https://docs.facefusion.io/introduction/licenses
- InsightFace — SCRFD 2.5g, ArcFace w600k r50, and INSwapper 128. The InsightFace code is MIT.
  The model weights are non-commercial. FaceFusion's license table marks INSwapper and ArcFace
  as Non-Commercial (InsightFace, 2023 and 2018) and SCRFD as Non-Commercial (InsightFace, 2021).
  https://github.com/deepinsight/insightface
- onnxruntime-web — MIT, Microsoft.

Weights
This repo does not contain the ONNX weights. The page downloads them in the browser from
FaceFusion's public model repo:

https://huggingface.co/facefusion/models-3.0.0

Files and approximate sizes:
- scrfd_2.5g.onnx — 3.1 MB
- arcface_w600k_r50.onnx — 166 MB
- inswapper_128_fp16.onnx — 265 MB
- together about 435 MB

Do not sell access to these models or ship them in a commercial product. A free personal page
is the use this project is built for. InsightFace asks commercial users of the inswapper series
to contact contact@insightface.ai.

Text-to-image uses the keyless Pollinations image endpoint (https://image.pollinations.ai).
That service is separate, rate-limited, and not part of FaceFusion.

Runtime
onnxruntime-web 1.31.1 (WASM, and WebGPU when the browser has it). Files under vendor/ort/
come from that package.
