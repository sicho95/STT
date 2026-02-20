# Offline STT (GitHub Pages)

## Deploy
- Upload these files at repo root.
- Enable GitHub Pages (branch main, folder / (root)).

## First run
Open the site online once and start a transcription to download/cache the model files.

## Notes
- WebGPU engine uses Transformers.js and downloads Whisper ONNX models from Hugging Face.
- WASM engine is a placeholder in this template (you can integrate whisper.cpp WASM single-thread later).
