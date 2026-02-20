let engine = null;
const post = (m) => self.postMessage(m);

class WebGPUEngine {
  constructor({ modelSource, modelId, language }){
    this.modelSource = modelSource;
    this.modelId = modelId;
    this.language = language;
    this.pipe = null;
  }

  async load(){
    // Simple: no bundler. ESM CDN.
    const { pipeline, env } = await import('https://esm.sh/@huggingface/transformers@3.0.0');

    if (this.modelSource === 'local') {
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = './models/';
    } else {
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
    }

    this.pipe = await pipeline('automatic-speech-recognition', this.modelId, {
      device: 'webgpu',
      dtype: 'q8',
      progress_callback: (p) => {
        if (typeof p?.progress === 'number') post({ type: 'progress', progress: p.progress });
      }
    });
  }

  async transcribe(pcm16k){
    const r = await this.pipe(pcm16k, {
      language: this.language === 'auto' ? undefined : this.language,
      return_timestamps: false
    });
    return r.text || '';
  }
}

class WasmEngine {
  constructor({ modelSource, modelId, language }){
    this.modelSource = modelSource;
    this.modelId = modelId;
    this.language = language;
  }
  async load(){
    // Template placeholder for whisper.cpp WASM single-thread.
    // If you want to fetch ggml-tiny remotely (first run), you can use:
    // https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
  }
  async transcribe(_pcm16k){
    return 'WASM fallback: placeholder (integrate whisper.cpp wasm here).';
  }
}

function makeEngine(kind, cfg){
  if (kind === 'webgpu') return new WebGPUEngine(cfg);
  if (kind === 'wasm') return new WasmEngine(cfg);
  throw new Error('Unknown engine');
}

self.onmessage = async (e) => {
  const msg = e.data;

  try {
    if (msg.type === 'load') {
      engine = makeEngine(msg.engine, msg);
      await engine.load();
      post({ type: 'ready' });
      return;
    }

    if (!engine) throw new Error('Engine not loaded');

    if (msg.type === 'transcribe-chunk') {
      const text = await engine.transcribe(msg.pcm16k);
      post({ type: 'partial', text });
      return;
    }

    if (msg.type === 'transcribe-final') {
      const text = await engine.transcribe(msg.pcm16k);
      post({ type: 'result', text });
      return;
    }

    if (msg.type === 'transcribe-file') {
      post({ type: 'file-progress', pct: 10 });
      const text = await engine.transcribe(msg.pcm16k);
      post({ type: 'file-progress', pct: 100 });
      post({ type: 'result', text });
      return;
    }

  } catch (err) {
    post({ type: 'error', error: err?.message || String(err) });
  }
};
