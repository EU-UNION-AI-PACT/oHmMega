#!/usr/bin/env -S node --no-warnings
/**
 * LLM Chatbots Leaderboard — Connectoren & Verbindung (Node 20+)
 * ---------------------------------------------------------------
 * Ein plattformübergreifendes CLI, das mehrere LLM‑Provider über Connectoren
 * anspricht, Health‑Checks durchführt und ein Leaderboard erzeugt.
 *
 * ✓ Provider: openai | azure | openai-compatible (z. B. Ollama/vLLM/LM Studio)
 * ✓ Metriken: Latenz, (geschätzte) Token, Kosten (Pricing‑Map), optional Qualität
 * ✓ Reports: JSON, Markdown, statisches HTML (sortable)
 * ✓ Robust: Concurrency, Timeout, Retries, Konfig via JSON + ENV
 *
 * Quickstart
 *   1) Node.js ≥ 20, ENV setzen (siehe unten)
 *   2) Konfig: leaderboard.config.json (Beispiel ganz unten)
 *   3) Prompts in ./prompts/*.md|*.txt (optional Front‑Matter: expected: ...)
 *   4) Run:
 *      node llm-leaderboard.ts \
 *        --config leaderboard.config.json \
 *        --outdir reports \
 *        --concurrency 3 \
 *        --timeout 30s
 *
 * ENV
 *   OPENAI_API_KEY=...
 *   AZURE_OPENAI_API_KEY=...   AZURE_OPENAI_ENDPOINT=https://<name>.openai.azure.com
 *   LOCAL_OPENAI_API_KEY=...   (falls openai‑compatible mit Key)
 *
 * Kommandozeilen‑Flags
 *   --config <file>       Pfad zur JSON‑Konfig (Provider, Pricing)
 *   --outdir <dir>        Ausgabeverzeichnis (default: reports)
 *   --prompts <dir>       Prompts‑Ordner (override Konfig)
 *   --concurrency <n>     Gleichzeitige Requests (default: 3)
 *   --timeout <dur>       10s | 30s | 2m (default: 30s)
 *   --max-prompts <n>     Limitiert die Anzahl Prompts
 *   --format <csv>        json,md,html (default: json,md,html)
 *   --check-only          Nur Connector‑Health prüfen
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { setTimeout as sleep } from 'timers/promises'

// ---------------- Types ----------------

type ProviderKind = 'openai' | 'azure' | 'openai-compatible'

interface Pricing { input?: number; output?: number } // $ per 1k tokens

interface ProviderConfig {
  id: string
  provider: ProviderKind
  // OpenAI / kompatibel
  model?: string
  baseUrl?: string // bei openai-compatible
  // Azure
  deployment?: string
  apiVersion?: string
  // Auth
  apiKeyEnv?: string // falls abweichend
  headers?: Record<string,string>
  pricing?: Pricing
}

interface ConfigFile {
  providers: ProviderConfig[]
  promptsDir?: string
  mode?: string // "speed,quality,cost"
}

interface PromptItem { id: string; text: string; expected?: string|null }

interface RunMetric {
  providerId: string
  promptId: string
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costUSD?: number
  output: string
  quality?: number
  error?: string|null
}

interface LeaderboardRow {
  providerId: string
  avgLatencyMs: number
  avgQuality: number|null
  totalCostUSD: number|null
  tokensIn?: number|null
  tokensOut?: number|null
  n: number
}

// --------------- CLI -------------------

function parseArgs(argv = process.argv.slice(2)){
  const get = (k: string, d?: string) => {
    const i = argv.findIndex(a => a === `--${k}` || a.startsWith(`--${k}=`))
    if (i === -1) return d
    return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i+1]
  }
  const has = (k: string) => argv.includes(`--${k}`)
  const outdir = path.resolve(get('outdir','reports')!)
  const config = get('config','leaderboard.config.json')!
  const promptsOverride = get('prompts')
  const concurrency = Math.max(1, parseInt(get('concurrency','3')!,10)||3)
  const timeout = parseDuration(get('timeout','30s')!)
  const maxPrompts = parseInt(get('max-prompts','0')!,10)||0
  const formats = (get('format','json,md,html')||'').split(',').map(s=>s.trim()).filter(Boolean)
  const checkOnly = has('check-only')
  return { outdir, config, promptsOverride, concurrency, timeoutMs: timeout, maxPrompts, formats, checkOnly }
}

function parseDuration(s: string){
  const m = /^(\d+)(ms|s|m)?$/i.exec(s.trim())
  if (!m) return 30000
  const n = parseInt(m[1],10)
  const u = (m[2]||'ms').toLowerCase()
  return u==='ms'? n : u==='s'? n*1000 : u==='m'? n*60000 : n
}

async function ensureDir(d: string){ await fs.mkdir(d,{recursive:true}); return d }

// --------------- Prompt Loading ----------

async function loadPrompts(dir?: string, max=0): Promise<PromptItem[]> {
  const defaults: PromptItem[] = [
    { id: 'tldr',  text: 'Erkläre in zwei Sätzen, was ein Software‑SBOM ist und wozu es dient.' },
    { id: 'regex', text: 'Schreibe ein Regex, das E‑Mail‑Adressen (einfach) erkennt, und nenne eine Grenze.', expected: '@' },
    { id: 'json',  text: 'Gib ein minimales JSON mit den Feldern name, version, license zurück.',         expected: '{' },
  ]
  if (!dir) return defaults.slice(0, max>0?Math.min(max,defaults.length):defaults.length)
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true })
    const files = ents.filter(e=>e.isFile() && /\.(txt|md)$/i.test(e.name)).map(e=>path.join(dir, e.name))
    const res: PromptItem[] = []
    for (const f of files) {
      const raw = await fs.readFile(f,'utf8')
      const { meta, body } = parseFrontMatter(raw)
      res.push({ id: path.basename(f).replace(/\.[^.]+$/,''), text: body.trim(), expected: (meta.expected??'')||null })
    }
    return res.slice(0, max>0?Math.min(max,res.length):res.length)
  } catch {
    return defaults.slice(0, max>0?Math.min(max,defaults.length):defaults.length)
  }
}

function parseFrontMatter(src: string){
  if (src.startsWith('---')){
    const end = src.indexOf('\n---',3)
    if (end>0){
      const head = src.slice(3,end).trim()
      const body = src.slice(end+4)
      const meta: Record<string,string> = {}
      head.split(/\r?\n/).forEach(line=>{
        const m = /^(\w+)\s*:\s*(.*)$/.exec(line.trim())
        if (m) meta[m[1]] = m[2]
      })
      return { meta, body }
    }
  }
  return { meta: {}, body: src }
}

// --------------- Provider Calls -----------

async function callProvider(p: ProviderConfig, userText: string, timeoutMs: number){
  const controller = new AbortController()
  const to = setTimeout(()=>controller.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const { url, headers, body } = buildRequest(p, userText)
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal as any })
    const t1 = performance.now()
    const latencyMs = Math.max(0, t1 - t0)
    if (!res.ok){
      const text = await res.text().catch(()=>res.statusText)
      return { error: `${res.status} ${res.statusText} :: ${text.slice(0,200)}`, latencyMs }
    }
    const data: any = await res.json()
    const output: string = data?.choices?.[0]?.message?.content ?? ''
    const usage = data?.usage
    const promptTokens = usage?.prompt_tokens
    const completionTokens = usage?.completion_tokens
    const totalTokens = usage?.total_tokens ?? (promptTokens && completionTokens ? promptTokens+completionTokens : undefined)
    return { output, latencyMs, promptTokens, completionTokens, totalTokens }
  } catch (e:any) {
    return { error: String(e?.message||e), latencyMs: performance.now() }
  } finally { clearTimeout(to) }
}

function buildRequest(p: ProviderConfig, userText: string){
  const sys = 'Antworte knapp und präzise.'
  const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : (
    p.provider==='openai' ? process.env.OPENAI_API_KEY :
    p.provider==='azure' ? process.env.AZURE_OPENAI_API_KEY : process.env.OPENAI_API_KEY || process.env.LOCAL_OPENAI_API_KEY
  )
  const extra = p.headers || {}

  if (p.provider==='openai'){
    const url = 'https://api.openai.com/v1/chat/completions'
    const headers: Record<string,string> = { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey||''}`, ...extra }
    const body = { model: p.model, messages:[{role:'system',content:sys},{role:'user',content:userText}], temperature:0 }
    return { url, headers, body }
  }
  if (p.provider==='azure'){
    const endpoint = (process.env.AZURE_OPENAI_ENDPOINT||'').replace(/\/$/, '')
    const dep = p.deployment
    const ver = p.apiVersion || '2024-02-15-preview'
    const url = `${endpoint}/openai/deployments/${dep}/chat/completions?api-version=${ver}`
    const headers: Record<string,string> = { 'Content-Type':'application/json', 'api-key': apiKey||'', ...extra }
    const body = { messages:[{role:'system',content:sys},{role:'user',content:userText}], temperature:0 }
    return { url, headers, body }
  }
  // openai-compatible
  const base = (p.baseUrl||'http://localhost:11434/v1').replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const headers: Record<string,string> = { 'Content-Type':'application/json', ...(apiKey?{'Authorization':`Bearer ${apiKey}`}:{}) , ...extra }
  const body = { model: p.model, messages:[{role:'system',content:sys},{role:'user',content:userText}], temperature:0 }
  return { url, headers, body }
}

// Health‑Check: kleine Anfrage mit trivialem Prompt
async function checkConnector(p: ProviderConfig, timeoutMs: number){
  const res = await callProvider(p, 'Sag "pong".', Math.min(timeoutMs, 10000))
  return { providerId: p.id, ok: !res.error, latencyMs: res.latencyMs, error: res.error||null, sample: (res as any).output||'' }
}

// --------------- Metrics & Scoring ---------

function estimateTokens(text: string){ return Math.max(1, Math.round(text.length/4)) }
function costUSD(pricing: Pricing|undefined, inTok?: number, outTok?: number){
  if (!pricing) return undefined
  const i = (inTok??0)/1000 * (pricing.input??0)
  const o = (outTok??0)/1000 * (pricing.output??0)
  const sum = i + o
  return Number(sum.toFixed(6))
}

// Zeichen‑Bigramm‑Dice (0..1)
function diceSimilarity(a: string, b: string){
  const bigrams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g,' ')
    const arr: string[] = []
    for (let i=0;i<t.length-1;i++) arr.push(t.slice(i,i+2))
    return arr
  }
  const A = bigrams(a), B = bigrams(b)
  if (!A.length || !B.length) return 0
  const map = new Map<string,number>()
  for (const x of A) map.set(x,(map.get(x)||0)+1)
  let inter=0
  for (const y of B){ const c = map.get(y)||0; if(c>0){ inter++; map.set(y,c-1) } }
  return (2*inter)/(A.length+B.length)
}

// --------------- Runner --------------------

async function run(){
  const args = parseArgs()
  await ensureDir(args.outdir)

  const cfg = JSON.parse(await fs.readFile(args.config,'utf8')) as ConfigFile
  const providers = cfg.providers||[]
  if (!providers.length) throw new Error('Keine Provider in config gefunden.')

  // Health‑Check (optional nur‑Check)
  const checks = await Promise.all(providers.map(p=>checkConnector(p, args.timeoutMs)))
  await fs.writeFile(path.join(args.outdir,'connectors.health.json'), JSON.stringify({ generatedAt:new Date().toISOString(), checks },null,2),'utf8')
  if (args.checkOnly){
    console.log('[OK] Connector‑Health geprüft.');
    return
  }

  const prompts = await loadPrompts(args.promptsOverride||cfg.promptsDir, args.maxPrompts)
  if (!prompts.length) throw new Error('Keine Prompts gefunden.')

  const results: RunMetric[] = []
  let active = 0
  const tasks: Promise<void>[] = []
  const enqueue = async (fn: ()=>Promise<void>) => { while(active>= (cfg as any).concurrency || active>=args.concurrency) await sleep(10); active++; try{ await fn() } finally { active-- } }

  for (const p of providers){
    for (const pr of prompts){
      tasks.push(enqueue(async ()=>{
        const r = await withRetry(async ()=> await callProvider(p, pr.text, args.timeoutMs), 2, 250)
        const estIn = r.promptTokens ?? estimateTokens(pr.text)
        const estOut = r.completionTokens ?? estimateTokens(r.output||'')
        const total = r.totalTokens ?? (estIn + estOut)
        const quality = pr.expected ? diceSimilarity(pr.expected, r.output||'') : undefined
        const cost = costUSD(p.pricing, estIn, estOut)
        results.push({ providerId:p.id, promptId:pr.id, latencyMs:r.latencyMs||0, promptTokens:estIn, completionTokens:estOut, totalTokens:total, costUSD:cost, output: r.output||'', quality, error:r.error||null })
      }))
    }
  }
  await Promise.all(tasks)

  // Aggregate → Leaderboards
  const rows = aggregate(results)
  const out = { generatedAt:new Date().toISOString(), prompts:prompts.map(p=>p.id), checks, results, leaderboards: rows }

  // Outputs
  if (args.formats.includes('json')) await fs.writeFile(path.join(args.outdir,'leaderboard.json'), JSON.stringify(out,null,2),'utf8')
  if (args.formats.includes('md'))   await fs.writeFile(path.join(args.outdir,'leaderboard.md'), renderMarkdown(out), 'utf8')
  if (args.formats.includes('html')) await fs.writeFile(path.join(args.outdir,'leaderboard.html'), renderHtml(out), 'utf8')

  console.log(`\n[OK] Leaderboard erzeugt in ${args.outdir}`)
}

function aggregate(results: RunMetric[]){
  const byProv = new Map<string, RunMetric[]>()
  for (const r of results){ const arr = byProv.get(r.providerId)||[]; arr.push(r); byProv.set(r.providerId, arr) }
  const rows: LeaderboardRow[] = []
  for (const [pid, arr] of byProv){
    const avgLat = average(arr.map(a=>a.latencyMs))
    const qVals = arr.map(a=>a.quality).filter(v=>typeof v==='number') as number[]
    const avgQ = qVals.length? average(qVals) : null
    const costs = arr.map(a=>a.costUSD).filter(v=>typeof v==='number') as number[]
    const totC = costs.length? sum(costs) : null
    const tin = sum(arr.map(a=>a.promptTokens||0)) || null
    const tout = sum(arr.map(a=>a.completionTokens||0)) || null
    rows.push({ providerId:pid, avgLatencyMs:round(avgLat,1), avgQuality:avgQ!=null?round(avgQ,3):null, totalCostUSD:totC!=null?round(totC,6):null, tokensIn:tin, tokensOut:tout, n:arr.length })
  }
  return {
    speed:   [...rows].sort((a,b)=> a.avgLatencyMs - b.avgLatencyMs),
    quality: [...rows].sort((a,b)=> (b.avgQuality??-1) - (a.avgQuality??-1)),
    cost:    [...rows].sort((a,b)=> (a.totalCostUSD??Infinity) - (b.totalCostUSD??Infinity))
  }
}

function average(xs: number[]){ return xs.length? xs.reduce((a,b)=>a+b,0)/xs.length : 0 }
function sum(xs: number[]){ return xs.reduce((a,b)=>a+b,0) }
function round(n: number, d=2){ const m = 10**d; return Math.round(n*m)/m }

async function withRetry<T>(fn: ()=>Promise<T>, retries=2, baseDelayMs=250): Promise<T>{
  let last: any
  for (let i=0;i<=retries;i++){
    try { return await fn() } catch(e){ last=e; await sleep(baseDelayMs*(i+1)) }
  }
  throw last
}

// --------------- Renderers ----------------

function renderMarkdown(out: any){
  let md = `# LLM Chatbots Leaderboard\n\nGeneriert: ${out.generatedAt}\n\n`
  md += `## Speed (Latenz)\n\n| Rank | Provider | Avg Latency (ms) | Avg Quality | Total Cost (USD) | N |\n|---:|---|---:|---:|---:|---:|\n`
  out.leaderboards.speed.forEach((r: LeaderboardRow, i: number)=>{
    md += `| ${i+1} | ${r.providerId} | ${r.avgLatencyMs} | ${r.avgQuality??'-'} | ${r.totalCostUSD??'-'} | ${r.n} |\n`
  })
  md += `\n## Quality (Dice)\n\n| Rank | Provider | Avg Quality | Avg Latency (ms) | Total Cost (USD) | N |\n|---:|---|---:|---:|---:|---:|\n`
  out.leaderboards.quality.forEach((r: LeaderboardRow, i: number)=>{
    md += `| ${i+1} | ${r.providerId} | ${r.avgQuality??'-'} | ${r.avgLatencyMs} | ${r.totalCostUSD??'-'} | ${r.n} |\n`
  })
  md += `\n## Cost\n\n| Rank | Provider | Total Cost (USD) | Avg Latency (ms) | Avg Quality | Tokens In | Tokens Out | N |\n|---:|---|---:|---:|---:|---:|---:|---:|\n`
  out.leaderboards.cost.forEach((r: LeaderboardRow, i: number)=>{
    md += `| ${i+1} | ${r.providerId} | ${r.totalCostUSD??'-'} | ${r.avgLatencyMs} | ${r.avgQuality??'-'} | ${r.tokensIn??'-'} | ${r.tokensOut??'-'} | ${r.n} |\n`
  })
  return md
}

function renderHtml(out: any){
  const esc = (s:any)=> String(s).replace(/[&<>]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))
  const table = (rows: LeaderboardRow[], cols:{key:keyof LeaderboardRow|'rank', label:string}[])=>{
    const head = cols.map(c=>`<th data-key="${c.key}">${esc(c.label)}</th>`).join('')
    const body = rows.map((r:LeaderboardRow,i:number)=>{
      const cells = cols.map(c=>{
        const v = (c.key==='rank')? (i+1) : (r as any)[c.key]
        return `<td>${esc(v==null?'-':v)}</td>`
      }).join('')
      return `<tr>${cells}</tr>`
    }).join('')
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }
  const speed = table(out.leaderboards.speed,[{key:'rank',label:'Rank'},{key:'providerId',label:'Provider'},{key:'avgLatencyMs',label:'Avg Latency (ms)'},{key:'avgQuality',label:'Avg Quality'},{key:'totalCostUSD',label:'Total Cost (USD)'},{key:'n',label:'N'}])
  const quality = table(out.leaderboards.quality,[{key:'rank',label:'Rank'},{key:'providerId',label:'Provider'},{key:'avgQuality',label:'Avg Quality'},{key:'avgLatencyMs',label:'Avg Latency (ms)'},{key:'totalCostUSD',label:'Total Cost (USD)'},{key:'n',label:'N'}])
  const cost = table(out.leaderboards.cost,[{key:'rank',label:'Rank'},{key:'providerId',label:'Provider'},{key:'totalCostUSD',label:'Total Cost (USD)'},{key:'avgLatencyMs',label:'Avg Latency (ms)'},{key:'avgQuality',label:'Avg Quality'},{key:'tokensIn',label:'Tokens In'},{key:'tokensOut',label:'Tokens Out'},{key:'n',label:'N'}])

  return `<!doctype html><html lang="de"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>LLM Chatbots Leaderboard</title>
<style>
  body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45;margin:24px;color:#0b1221;background:#0b12210a}
  h1,h2{margin:0 0 12px}
  .wrap{max-width:1100px;margin:0 auto}
  table{border-collapse:collapse;width:100%;margin:8px 0 24px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.05)}
  th,td{padding:10px 12px;border-bottom:1px solid #eef2f7}
  thead th{cursor:pointer;user-select:none;background:#f8fafc;position:sticky;top:0}
  tr:hover{background:#f9fbff}
  .meta{color:#455;font-size:12px;margin-bottom:18px}
  code{background:#f1f5f9;padding:2px 6px;border-radius:4px}
</style>
<div class="wrap">
  <h1>LLM Chatbots Leaderboard</h1>
  <div class="meta">Generiert: ${esc(out.generatedAt)} · Prompts: ${out.prompts.length}</div>
  <h2>Speed</h2>${speed}
  <h2>Quality</h2>${quality}
  <h2>Cost</h2>${cost}
</div>
<script>
  document.querySelectorAll('table thead th').forEach(th=>{
    th.addEventListener('click', ()=>{
      const table = th.closest('table');
      const idx = Array.from(th.parentNode.children).indexOf(th);
      const asc = th.dataset.asc==='1'?false:true; th.dataset.asc=asc?'1':'0';
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      rows.sort((a,b)=>{
        const va = a.children[idx].innerText; const vb = b.children[idx].innerText;
        const na = parseFloat(va); const nb = parseFloat(vb);
        const cmp = (!isNaN(na)&&!isNaN(nb)) ? (na-nb) : va.localeCompare(vb);
        return asc? cmp : -cmp;
      });
      rows.forEach(r=>table.querySelector('tbody').appendChild(r));
    })
  })
</script></html>`
}

// ---------------- Footer: Sample Config ----------------
/*
leaderboard.config.json (Beispiel)
{
  "providers": [
    {
      "id": "gpt-4o-mini",
      "provider": "openai",
      "model": "gpt-4o-mini",
      "pricing": { "input": 0.00015, "output": 0.00060 }
    },
    {
      "id": "azure-gpt4o",
      "provider": "azure",
      "deployment": "gpt4o-mini",
      "apiVersion": "2024-02-15-preview",
      "pricing": { "input": 0.00015, "output": 0.00060 }
    },
    {
      "id": "local-llama3",
      "provider": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3:instruct",
      "apiKeyEnv": "LOCAL_OPENAI_API_KEY",
      "pricing": { "input": 0, "output": 0 }
    }
  ],
  "promptsDir": "prompts",
  "mode": "speed,quality,cost"
}
*/

// ---------------- Start -------------------
run().catch(e=>{ console.error('[ERR]', e?.stack||e); process.exit(1) })
