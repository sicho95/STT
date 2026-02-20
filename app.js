const LS_KEY = 'offline-stt-settings-v1';

const DEFAULTS = {
  engine: 'auto',
  modelSource: 'remote',
  modelId: 'onnx-community/whisper-tiny',
  language: 'auto',
  chunkSec: 5
};

const MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'Whisper Tiny (ONNX, remote)' },
  { id: 'onnx-community/whisper-tiny.en', label: 'Whisper Tiny EN (ONNX, remote)' },
  { id: 'ggml-tiny', label: 'GGML Tiny (WASM)' }
];

function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }

function el(id){ return document.getElementById(id); }
function setPill(id, txt){ el(id).textContent = txt; }
function isOnline(){ return navigator.onLine; }
function hasWebGPU(){ return !!navigator.gpu; }

class Recorder {
  constructor(){ this.stream=null; this.ctx=null; this.proc=null; this.chunks=[]; }
  async start(){
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e)=> this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
  }
  stop(){
    if (this.stream) this.stream.getTracks().forEach(t=>t.stop());
    if (this.proc) this.proc.disconnect();
    const sr = this.ctx?.sampleRate || 48000;
    if (this.ctx) this.ctx.close();
    const total = this.chunks.reduce((s,c)=>s+c.length,0);
    const out = new Float32Array(total);
    let off=0; for (const c of this.chunks){ out.set(c, off); off += c.length; }
    this.chunks=[];
    return { pcm: out, sampleRate: sr };
  }
  getRecentSeconds(sec){
    if (!this.ctx) return { pcm: new Float32Array(0), sampleRate: 48000 };
    const sr = this.ctx.sampleRate;
    const want = Math.floor(sec*sr);
    const total = this.chunks.reduce((s,c)=>s+c.length,0);
    if (!total) return { pcm: new Float32Array(0), sampleRate: sr };
    const all = new Float32Array(total);
    let off=0; for (const c of this.chunks){ all.set(c, off); off += c.length; }
    const start = Math.max(0, all.length - want);
    return { pcm: all.slice(start), sampleRate: sr };
  }
}

function resampleTo16k(float32, srcRate){
  const dstRate=16000;
  if (srcRate === dstRate) return float32;
  const ratio = dstRate/srcRate;
  const newLen = Math.floor(float32.length * ratio);
  const out = new Float32Array(newLen);
  for (let i=0;i<newLen;i++){
    const srcIdx=i/ratio;
    const i0=Math.floor(srcIdx);
    const i1=Math.min(i0+1, float32.length-1);
    const t=srcIdx-i0;
    out[i]=float32[i0]*(1-t)+float32[i1]*t;
  }
  return out;
}

async function decodeFileToPCM16k(file){
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(buf);
  const ch0 = audio.getChannelData(0);
  const pcm16k = resampleTo16k(ch0, audio.sampleRate);
  ctx.close();
  return pcm16k;
}

let settings = loadSettings();
let worker = null;
let recorder = null;
let timer = null;

function openDrawer(open){
  const d = el('drawer');
  d.classList.toggle('open', open);
  d.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function populateModels(){
  const s = el('modelSelect');
  s.innerHTML='';
  for (const m of MODELS){
    const o = document.createElement('option');
    o.value=m.id; o.textContent=m.label;
    if (m.id === settings.modelId) o.selected=true;
    s.appendChild(o);
  }
}

function appendTranscript(text, partial){
  const box = el('transcript');
  if (partial){
    const prev = box.querySelector('.partial');
    if (prev) prev.remove();
    const div = document.createElement('div');
    div.className='partial';
    div.textContent=text;
    box.appendChild(div);
  } else {
    const div = document.createElement('div');
    div.textContent=text;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function clearTranscript(){ el('transcript').innerHTML=''; }

function onWorkerMsg(msg){
  if (msg.type === 'ready') setPill('modelStatus','model: ready');
  if (msg.type === 'progress'){
    const pct = Math.round((msg.progress||0)*100);
    setPill('modelStatus', `model: ${pct}%`);
  }
  if (msg.type === 'partial') appendTranscript(msg.text||'', true);
  if (msg.type === 'result') appendTranscript(msg.text||'', false);
  if (msg.type === 'error'){
    setPill('modelStatus','model: error');
    alert(msg.error||'Erreur');
  }
  if (msg.type === 'file-progress'){
    el('fileProgress').style.width = `${Math.max(0, Math.min(100, msg.pct||0))}%`;
  }
}

async function ensureLoaded(){
  const forced = settings.engine;
  const effective = forced === 'auto' ? (hasWebGPU() ? 'webgpu' : 'wasm') : forced;
  setPill('engineStatus', `engine: ${effective}`);
  setPill('modelStatus', 'model: loading…');
  worker.postMessage({
    type: 'load',
    engine: effective,
    modelSource: settings.modelSource,
    modelId: settings.modelId,
    language: settings.language
  });
}

async function startMic(){
  await ensureLoaded();
  recorder = new Recorder();
  await recorder.start();

  el('micBtn').disabled = true;
  el('stopBtn').disabled = false;

  const sec = Math.max(2, Number(settings.chunkSec)||5);
  timer = setInterval(()=>{
    if (!recorder) return;
    const { pcm, sampleRate } = recorder.getRecentSeconds(sec);
    const pcm16k = resampleTo16k(pcm, sampleRate);
    worker.postMessage({ type: 'transcribe-chunk', pcm16k });
  }, sec*1000);
}

async function stopMic(){
  if (timer) clearInterval(timer);
  timer = null;

  const { pcm, sampleRate } = recorder.stop();
  recorder = null;

  el('micBtn').disabled = false;
  el('stopBtn').disabled = true;

  const pcm16k = resampleTo16k(pcm, sampleRate);
  worker.postMessage({ type: 'transcribe-final', pcm16k });
}

async function transcribeFile(file){
  await ensureLoaded();
  el('fileProgress').style.width='0%';
  const pcm16k = await decodeFileToPCM16k(file);
  worker.postMessage({ type: 'transcribe-file', pcm16k });
}

async function purgeCaches(){
  const keys = await caches.keys();
  await Promise.all(keys.map(k=>caches.delete(k)));
  alert('Caches supprimés. Recharge la page.');
}

function bindUI(){
  el('hamburger').onclick = ()=> openDrawer(true);
  el('drawerClose').onclick = ()=> openDrawer(false);

  document.querySelectorAll('input[name="engine"]').forEach(r=>{
    r.checked = (r.value === settings.engine);
    r.addEventListener('change', ()=>{ settings.engine = r.value; saveSettings(settings); setPill('modelStatus','model: -'); });
  });
  document.querySelectorAll('input[name="modelSource"]').forEach(r=>{
    r.checked = (r.value === settings.modelSource);
    r.addEventListener('change', ()=>{ settings.modelSource = r.value; saveSettings(settings); setPill('modelStatus','model: -'); });
  });

  populateModels();
  el('modelSelect').addEventListener('change', (e)=>{ settings.modelId = e.target.value; saveSettings(settings); setPill('modelStatus','model: -'); });

  el('langSelect').value = settings.language;
  el('langSelect').addEventListener('change', (e)=>{ settings.language = e.target.value; saveSettings(settings); });

  el('chunkSec').value = String(settings.chunkSec);
  el('chunkSec').addEventListener('change', (e)=>{ settings.chunkSec = Number(e.target.value)||5; saveSettings(settings); });

  el('micBtn').onclick = async ()=>{ clearTranscript(); try{ await startMic(); }catch(e){ alert(e.message||String(e)); el('micBtn').disabled=false; el('stopBtn').disabled=true; } };
  el('stopBtn').onclick = async ()=>{ try{ await stopMic(); }catch(e){ alert(e.message||String(e)); } };

  el('fileInput').addEventListener('change', async (e)=>{
    const f = e.target.files?.[0];
    if (!f) return;
    clearTranscript();
    try { await transcribeFile(f); }
    catch(err){ alert(err.message||String(err)); }
    finally { e.target.value=''; }
  });

  el('copyBtn').onclick = async ()=>{ await navigator.clipboard.writeText(el('transcript').innerText); alert('Copié'); };
  el('exportBtn').onclick = ()=>{
    const txt = el('transcript').innerText;
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  el('purgeModelCache').onclick = purgeCaches;
}

async function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('./sw.js', { scope: './' }); }
  catch(e) { console.warn('SW register failed', e); }
}

function refreshNet(){ setPill('netStatus', isOnline() ? 'online' : 'offline'); }

function main(){
  refreshNet();
  window.addEventListener('online', refreshNet);
  window.addEventListener('offline', refreshNet);

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e)=> onWorkerMsg(e.data);

  bindUI();
  registerSW();

  setPill('engineStatus', `engine: ${settings.engine}`);
  setPill('modelStatus', 'model: -');
}
main();
