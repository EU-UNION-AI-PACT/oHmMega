#!/usr/bin/env -S node --experimental-modules --no-warnings
/**
 * Chatbot Leaderboard — plattformübergreifendes CLI
 * -------------------------------------------------
 * Vergleicht Chat‑Assist‑Bots (z. B. ChatGPT/OpenAI, Azure OpenAI, OpenAI‑kompatible/Lokal)
 * anhand einfacher Metriken: Latenz, (geschätzte) Token, Kosten, Qualitäts‑Score.
 *
 * Features
 * - Konnektoren: openai | azure | openai-compatible (z. B. Ollama, vLLM, LM Studio)
 * - Prompts aus Verzeichnis oder Inline‑Defaults
 * - Optional „expected“ Antworten per YAML‑Header im Prompt für Qualitäts‑Score
 * - Retries mit Backoff, Timeouts, Konfig über JSON + ENV
 * - Reports: JSON, Markdown, statisches HTML (sortable)
 *
 * Quickstart
 *   1) Node.js >= 20
 *   2) Datei leaderboard.config.json anlegen (Beispiel siehe unten)
 *   3) Prompts in ./prompts (optional) oder Defaults nutzen
 *   4) Ausführen:
 *      node chatbot-leaderboard.ts \
 *        --config leaderboard.config.json \
 *        --outdir reports \
 *        --concurrency 3 \
 *        --timeout 30s
 *
 * ENV
 *   OPENAI_API_KEY=...              (für provider:"openai")
 *   AZURE_OPENAI_API_KEY=...        (für provider:"azure")
 *   AZURE_OPENAI_ENDPOINT=...       (z. B. https://<name>.openai.azure.com)
 *   <CUSTOM_KEY_ENV>=...            (falls im Provider gesetzt: apiKeyEnv)
 *
 * Beispiel leaderboard.config.json
 * {
 *   "providers": [
 *     {
 *       "id": "gpt-4o-mini",
 *       "provider": "openai",
 *       "model": "gpt-4o-mini",
 *       "pricing": { "input": 0.00015, "output": 0.00060 }
 *     },
 *     {
 *       "id": "azure-gpt4o",
 *       "provider": "azure",
 *       "deployment": "gpt4o-mini",
 *       "apiVersion": "2024-02-15-preview",
 *       "pricing": { "input": 0.00015, "output": 0.00060 }
 *     },
 *     {
 *       "id": "local-llama3",
 *       "provider": "openai-compatible",
 *       "baseUrl": "http://localhost:11434/v1",
 *       "model": "llama3:instruct",
 *       "apiKeyEnv": "LOCAL_OPENAI_API_KEY",
 *       "pricing": { "input": 0, "output": 0 }
 *     }
 *   ],
 *   "promptsDir": "prompts",
 *   "mode": "speed,quality,cost"
 * }
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
  model?: string
  // openai-compatible
  baseUrl?: string
  // azure
  deployment?: string
  apiVersion?: string
  // auth
  apiKeyEnv?: string
  // pricing
  pricing?: Pricing
  // extra headers
  headers?: Record<string, string>
}

interface ConfigFile {
  providers: ProviderConfig[]
  promptsDir?: string
  mode?: string // "speed,quality,cost"
}

interface PromptItem { id: string; text: string; expected?: string | null }

interface RunMetric {
  providerId: string
  promptId: string
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costUSD?: number
  output: string
  quality?: number // 0..1
  error?: string | null
}

interface LeaderboardRow {
  providerId: string
  avgLatencyMs: number
  avgQuality: number | null
  totalCostUSD: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  n: number
}

// --------------- CLI -------------------

function parseArgs(argv = process.argv.slice(2)){
  const get = (k: string, d?: string) => {
    const i = argv.findIndex(a => a === `--${k}` || a.startsWith(`--${k}=`))
    if (i === -1) return d
    if (argv[i].includes('=')) return argv[i].split('=')[1]
    return argv[i+1]
  }
  const has = (k: string) => argv.includes(`--${k}`)
  const outdir = path.resolve(get('outdir','reports')!)
  const config = get('config','leaderboard.config.json')!
  const concurrency = Math.max(1, parseInt(get('concurrency','3')!,10)||3)
  const timeout = parseDuration(get('timeout','30s')!)
  const maxPrompts = parseInt(get('max-prompts','0')!,10)||0
  return { outdir, config, concurrency, timeoutMs: timeout, maxPrompts, strict: has('strict') }
}

function parseDuration(s: string){
  const m = /^(\d+)(ms|s|m)?$/i.exec(s.trim())
  if (!m) return 30000
  const n = parseInt(m[1],10)
  const u = (m[2]||'ms').toLowerCase()
  if (u==='ms') return n
  if (u==='s') return n*1000
  if (u==='m') return n*60*1000
  return n
}

async function ensureDir(d: string){ await fs.mkdir(d,{recursive:true}); return d }

// --------------- Prompt Loading ----------

async function loadPrompts(dir?: string, max=0): Promise<PromptItem[]> {
  const defaults: PromptItem[] = [
    { id: 'tldr', text: 'Erkläre in zwei Sätzen, was ein Software‑SBOM ist und wozu es dient.' },
    { id: 'regex', text: 'Schreibe ein Regex, das E‑Mail‑Adressen (einfach) erkennt, und erkläre 1 Grenze.' , expected: '@' },
    { id: 'json', text: 'Gib ein minimales JSON mit den Feldern name, version, license zurück.' , expected: '{' },
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

// --------------- Providers ----------------

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
    p.provider==='azure' ? process.env.AZURE_OPENAI_API_KEY : process.env.OPENAI_API_KEY
  )
  const extraHeaders = p.headers || {}

  if (p.provider==='openai'){
    const url = 'https://api.openai.com/v1/chat/completions'
    const headers: Record<string,string> = { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey||''}`, ...extraHeaders }
    const body = { model: p.model, messages:[{role:'system',content:sys},{role:'user',content:userText}], temperature: 0 }
    return { url, headers, body }
  }
  if (p.provider==='azure'){
    const endpoint = (process.env.AZURE_OPENAI_ENDPOINT||'').replace(/\/$/, '')
    const dep = p.deployment
    const ver = p.apiVersion || '2024-02-15-preview'
    const url = `${endpoint}/openai/deployments/${dep}/chat/completions?api-version=${ver}`
    const headers: Record<string,string> = { 'Content-Type':'application/json', 'api-key': apiKey||'', ...extraHeaders }
    const body = { messages:[{role:'system',content:sys},{role:'user',content:userText}], temperature:0 }
    return { url, headers, body }
  }
  // openai-compatible
  const base = (p.baseUrl||'http://localhost:11434/v1').replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const headers: Record<string,string> = { 'Content-Type':'application/json', ...(apiKey?{'Authorization':`Bearer ${apiKey}`}:{}) , ...extraHeaders }
  const body = { model: p.model, messages:[{role:'system',content:sys},{role:'user',content:userText}], temperature:0 }
  return { url, headers, body }
}

// --------------- Metrics & Scoring ---------

function estimateTokens(text: string){
  // sehr grobe Schätzung als Fallback
  return Math.max(1, Math.round(text.length / 4))
}

function costUSD(pricing: Pricing|undefined, inTok?: number, outTok?: number){
  if (!pricing) return undefined
  const i = (inTok??0)/1000 * (pricing.input??0)
  const o = (outTok??0)/1000 * (pricing.output??0)
  const sum = i + o
  return sum>0 ? Number(sum.toFixed(6)) : 0
}

// Zeichen-Bigramm-Dice-Ähnlichkeit (0..1)
function diceSimilarity(a: string, b: string){
  const bigrams = (s: string) => {
    const arr: string[] = []
    const t = s.toLowerCase().replace(/\s+/g,' ')
    for (let i=0;i<t.length-1;i++) arr.push(t.slice(i,i+2))
    return arr
  }
  const A = bigrams(a), B = bigrams(b)
  if (!A.length || !B.length) return 0
  const map = new Map<string,number>()
  for (const x of A) map.set(x, (map.get(x)||0)+1)
  let inter = 0
  for (const y of B){ const c = map.get(y)||0; if (c>0){ inter++; map.set(y,c-1) } }
  return (2*inter) / (A.length + B.length)
}

// --------------- Runner --------------------

async function run(){
  const args = parseArgs()
  await ensureDir(args.outdir)

  // Load config
  const cfg = JSON.parse(await fs.readFile(args.config,'utf8')) as ConfigFile
  const providers = cfg.providers || []
  if (!providers.length) throw new Error('Keine Provider in config gefunden.')
  const prompts = await loadPrompts(cfg.promptsDir, args.maxPrompts)
  if (!prompts.length) throw new Error('Keine Prompts gefunden.')

  const mode = (cfg.mode||'speed,quality,cost').split(',').map(s=>s.trim())

  const results: RunMetric[] = []
  const queue: Promise<void>[] = []
  let active = 0
  const next = async (job: ()=>Promise<void>) => {
    while (active >= args.concurrency) await sleep(10)
    active++; try { await job() } finally { active-- }
  }

  for (const p of providers){
    for (const pr of prompts){
      queue.push(next(async ()=>{
        const r = await withRetry(async ()=> await callProvider(p, pr.text, args.timeoutMs), 2, 300)
        let promptTokens = r.promptTokens
        let completionTokens = r.completionTokens
        let totalTokens = r.totalTokens
        if (!totalTokens){
          const estIn = estimateTokens(pr.text)
          const estOut = estimateTokens(r.output||'')
          promptTokens = promptTokens ?? estIn
          completionTokens = completionTokens ?? estOut
          totalTokens = estIn + estOut
        }
        const cst = costUSD(p.pricing, promptTokens, completionTokens)
        const quality = pr.expected ? diceSimilarity(pr.expected, r.output||'') : undefined
        results.push({ providerId: p.id, promptId: pr.id, latencyMs: r.latencyMs||0, promptTokens, completionTokens, totalTokens, costUSD: cst, output: r.output||'', quality, error: r.error||null })
      }))
    }
  }
  await Promise.all(queue)

  // Aggregate
  const byProv = new Map<string, RunMetric[]>()
  for (const r of results){
    const arr = byProv.get(r.providerId) || []; arr.push(r); byProv.set(r.providerId, arr)
  }
  const rows: LeaderboardRow[] = []
  for (const [pid, arr] of byProv){
    const lat = average(arr.map(a=>a.latencyMs))
    const q = arr.some(a=>typeof a.quality==='number') ? average(arr.filter(a=>typeof a.quality==='number').map(a=>a.quality||0)) : null
    const costVals = arr.map(a=>a.costUSD).filter(v=>typeof v==='number') as number[]
    const cost = costVals.length ? sum(costVals) : null
    const tin = sum(arr.map(a=>a.promptTokens||0)) || null
    const tout = sum(arr.map(a=>a.completionTokens||0)) || null
    rows.push({ providerId: pid, avgLatencyMs: round(lat,1), avgQuality: q!=null?round(q,3):null, totalCostUSD: cost!=null?round(cost,6):null, tokensIn: tin, tokensOut: tout, n: arr.length })
  }

  // Sortierungen
  const speed = [...rows].sort((a,b)=> a.avgLatencyMs - b.avgLatencyMs)
  const quality = [...rows].sort((a,b)=> (b.avgQuality??-1) - (a.avgQuality??-1))
  const cost = [...rows].sort((a,b)=> (a.totalCostUSD??Infinity) - (b.totalCostUSD??Infinity))

  const out = { generatedAt: new Date().toISOString(), prompts: prompts.map(p=>p.id), results, leaderboards: { speed, quality, cost } }
  await fs.writeFile(path.join(args.outdir,'leaderboard.json'), JSON.stringify(out,null,2),'utf8')
  await fs.writeFile(path.join(args.outdir,'leaderboard.md'), renderMarkdown(out), 'utf8')
  await fs.writeFile(path.join(args.outdir,'leaderboard.html'), renderHtml(out), 'utf8')

  console.log(`\n[OK] Leaderboard erzeugt in ${args.outdir}`)
}

function average(xs: number[]){ return xs.length? xs.reduce((a,b)=>a+b,0)/xs.length : 0 }
function sum(xs: number[]){ return xs.reduce((a,b)=>a+b,0) }
function round(n: number, d=2){ const m = 10**d; return Math.round(n*m)/m }

async function withRetry<T>(fn: ()=>Promise<T>, retries=2, baseDelayMs=250): Promise<T>{
  let lastErr: any
  for (let i=0;i<=retries;i++){
    try { return await fn() } catch(e:any){ lastErr = e; await sleep(baseDelayMs * (i+1)) }
  }
  throw lastErr
}

// --------------- Renderers ----------------

function renderMarkdown(out: any){
  let md = `# Chatbot Leaderboard\n\nGeneriert: ${out.generatedAt}\n\n`
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
  const esc = (s: any)=> String(s).replace(/[&<>]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))
  const table = (rows: LeaderboardRow[], cols: { key: keyof LeaderboardRow | 'rank' | 'providerId'; label: string }[]) => {
    const head = cols.map(c=>`<th data-key="${c.key}">${esc(c.label)}</th>`).join('')
    const body = rows.map((r: LeaderboardRow, i: number)=>{
      const cells = cols.map(c=>{
        const v = c.key==='rank'? (i+1) : (r as any)[c.key]
        return `<td>${esc(v==null?'-':v)}</td>`
      }).join('')
      return `<tr>${cells}</tr>`
    }).join('')
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }
  const speed = table(out.leaderboards.speed, [
    {key:'rank',label:'Rank'},{key:'providerId',label:'Provider'},{key:'avgLatencyMs',label:'Avg Latency (ms)'},{key:'avgQuality',label:'Avg Quality'},{key:'totalCostUSD',label:'Total Cost (USD)'},{key:'n',label:'N'}
  ])
  const quality = table(out.leaderboards.quality, [
    {key:'rank',label:'Rank'},{key:'providerId',label:'Provider'},{key:'avgQuality',label:'Avg Quality'},{key:'avgLatencyMs',label:'Avg Latency (ms)'},{key:'totalCostUSD',label:'Total Cost (USD)'},{key:'n',label:'N'}
  ])
  const cost = table(out.leaderboards.cost, [
    {key:'rank',label:'Rank'},{key:'providerId',label:'Provider'},{key:'totalCostUSD',label:'Total Cost (USD)'},{key:'avgLatencyMs',label:'Avg Latency (ms)'},{key:'avgQuality',label:'Avg Quality'},{key:'tokensIn',label:'Tokens In'},{key:'tokensOut',label:'Tokens Out'},{key:'n',label:'N'}
  ])

  return `<!doctype html>
<html lang="de">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Chatbot Leaderboard</title>
<style>
  body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.4;margin:24px;color:#0b1221;background:#0b12210a}
  h1,h2{margin:0 0 12px}
  .wrap{max-width:1100px;margin:0 auto}
  table{border-collapse:collapse;width:100%;margin:8px 0 24px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.05)}
  th,td{padding:10px 12px;border-bottom:1px solid #eef2f7}
  thead th{cursor:pointer;user-select:none;background:#f8fafc;position:sticky;top:0}
  tr:hover{background:#f9fbff}
  .meta{color:#455; font-size:12px; margin-bottom:18px}
  code{background:#f1f5f9;padding:2px 6px;border-radius:4px}
</style>
<div class="wrap">
  <h1>Chatbot Leaderboard</h1>
  <div class="meta">Generiert: ${esc(out.generatedAt)} · Prompts: ${out.prompts.length}</div>
  <h2>Speed</h2>
  ${speed}
  <h2>Quality</h2>
  ${quality}
  <h2>Cost</h2>
  ${cost}
</div>
<script>
  // Simple column sort
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
</script>
</html>`
}

// --------------- Start ---------------------

run().catch(e=>{ console.error('[ERR]', e?.stack||e); process.exit(1) })
