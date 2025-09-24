# Connector‑Skeletons — Docker • Kubernetes • Agents • RAG • Async

Einbaukasten für deine CLI (**`giants`**) in Container/Cluster und smarte Agenten. Selten, schlank, direkt integrierbar. Alles „best effort“ und leicht erweiterbar.

> **Kontrakt**: `GIANTS_BIN` (Pfad zur CLI), `giants.config.json` im Projekt (Optionen), JSON/NDJSON‑Output, Exit‑Codes konform.

---

## 1) Docker

**docker/Dockerfile**
```dockerfile
# Multi‑Stage: Builder (optional) + Runtime
FROM node:20-slim AS base
WORKDIR /app

# Optional: bring deine CLI rein (Monorepo → build step)
# COPY . .
# RUN corepack enable && pnpm -v && pnpm i --frozen-lockfile && pnpm -r build

# Runtime‑Image
FROM node:20-slim AS runtime
WORKDIR /work
ENV NODE_ENV=production \
    GIANTS_BIN=giants
# Hilfsskript (kann durch deine echte Bin/Wrapper ersetzt werden)
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY docker/giants-run.sh /usr/local/bin/giants-run
RUN chmod +x /usr/local/bin/giants-run
ENTRYPOINT ["/usr/local/bin/giants-run"]
```

**docker/giants-run.sh**
```bash
#!/usr/bin/env bash
set -euo pipefail
BIN="${GIANTS_BIN:-giants}"
TASK="${GIANTS_TASK:-quick-scan}"
ARGS=${GIANTS_ARGS:-"--json"}
# Mountpoint: /work ist Projektwurzel
cd /work
exec "$BIN" run $ARGS --task "$TASK"
```

**docker/compose.yml**
```yaml
version: "3.9"
services:
  giants:
    build: { context: ., dockerfile: docker/Dockerfile }
    image: giants/cli:local
    working_dir: /work
    volumes:
      - ./:/work
      - giants_data:/work/data
    environment:
      - GIANTS_BIN=giants
      - GIANTS_TASK=${GIANTS_TASK:-quick-scan}
      - GIANTS_ARGS=--json
      - OPENAI_API_KEY
    depends_on:
      - redis
      - qdrant
  redis:
    image: redis:7-alpine
  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant_data:/qdrant/storage
volumes:
  giants_data: {}
  qdrant_data: {}
```

---

## 2) Kubernetes ("Kubernetics" 😉)

**k8s/01-namespace.yaml**
```yaml
apiVersion: v1
kind: Namespace
metadata: { name: giants }
```

**k8s/02-configmap.yaml**
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: giants-config, namespace: giants }
data:
  giants.config.json: |
    { "bin": "giants", "defaultTask": "quick-scan", "args": ["--json"] }
```

**k8s/03-secret.yaml**
```yaml
apiVersion: v1
kind: Secret
metadata: { name: giants-secrets, namespace: giants }
stringData:
  OPENAI_API_KEY: "REPLACE_ME"
```

**k8s/04-rbac.yaml**
```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: giants-sa, namespace: giants }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: giants-role, namespace: giants }
rules:
  - apiGroups: [""]
    resources: ["pods","pods/log","configmaps","secrets"]
    verbs: ["get","list","watch","create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: giants-rb, namespace: giants }
subjects: [{ kind: ServiceAccount, name: giants-sa, namespace: giants }]
roleRef: { kind: Role, name: giants-role, apiGroup: rbac.authorization.k8s.io }
```

**k8s/05-job.yaml** (einmaliger Lauf)
```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: giants-run, namespace: giants }
spec:
  template:
    spec:
      serviceAccountName: giants-sa
      restartPolicy: Never
      containers:
        - name: giants
          image: giants/cli:local # oder ghcr.io/you/giants:TAG
          imagePullPolicy: IfNotPresent
          envFrom:
            - secretRef: { name: giants-secrets }
          env:
            - { name: GIANTS_TASK, value: "quick-scan" }
            - { name: GIANTS_ARGS,  value: "--json" }
          volumeMounts:
            - { name: cfg, mountPath: /work/giants.config.json, subPath: giants.config.json }
            - { name: data, mountPath: /work/data }
      volumes:
        - { name: cfg,  configMap: { name: giants-config } }
        - { name: data, emptyDir: {} }
```

**k8s/06-cronjob.yaml** (zeitgesteuert)
```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: giants-nightly, namespace: giants }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: giants-sa
          restartPolicy: Never
          containers:
            - name: giants
              image: giants/cli:local
              envFrom:
                - secretRef: { name: giants-secrets }
              env:
                - { name: GIANTS_TASK, value: "nightly-audit" }
```

**k8s/07-deployment.yaml** (API/Worker‑Dauerläufer)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: giants-worker, namespace: giants }
spec:
  replicas: 1
  selector: { matchLabels: { app: giants-worker } }
  template:
    metadata: { labels: { app: giants-worker } }
    spec:
      serviceAccountName: giants-sa
      containers:
        - name: worker
          image: giants/cli:local
          command: ["node","apps/worker/dist/index.js"]
          envFrom: [ { secretRef: { name: giants-secrets } } ]
          volumeMounts:
            - { name: data, mountPath: /work/data }
      volumes:
        - { name: data, emptyDir: {} }
```

**k8s/08-service.yaml** (falls API)
```yaml
apiVersion: v1
kind: Service
metadata: { name: giants-api, namespace: giants }
spec:
  selector: { app: giants-api }
  ports: [ { name: http, port: 8080, targetPort: 8080 } ]
```

**Helm‑Skeleton**
```
helm/giants/
  Chart.yaml
  values.yaml
  templates/
    _helpers.tpl
    configmap.yaml
    secret.yaml
    deployment.yaml
    service.yaml
    job.yaml
    cronjob.yaml
```

**helm/giants/values.yaml (Auszug)**
```yaml
image: { repository: giants/cli, tag: "local", pullPolicy: IfNotPresent }
env:
  OPENAI_API_KEY: ""
args: ["--json"]
task: "quick-scan"
cron:
  enabled: true
  schedule: "0 3 * * *"
```

---

## 3) Agenten / Coding‑Assistenten (Lazy/Vibing/RAG/Async)

**packages/agents/src/index.ts**
```ts
export type Tool = 'docker'|'k8s'|'deep-search'|'rag'|'code-run'|'async-queue'
export type Mode = 'coding_assistant'|'lazy_coding'|'vibing_coding'|'rag_coding'|'async_coding'|'research'|'fetinch'

export interface AgentConfig { mode: Mode; tools: Tool[]; systemPrompt?: string }

export interface Context { cwd: string; env: Record<string,string> }

export interface ToolImpl {
  name: Tool
  run(input: any, ctx: Context): Promise<any>
}

export class Agent {
  constructor(private cfg: AgentConfig, private tools: Record<Tool,ToolImpl>){ }
  async handle(user: string, ctx: Context){
    // Minimal: route je nach Mode
    if(this.cfg.mode==='rag_coding') return this.tools['rag'].run({ query:user }, ctx)
    if(this.cfg.mode==='async_coding') return this.tools['async-queue'].run({ task:user }, ctx)
    if(this.cfg.mode==='research' || this.cfg.mode==='fetinch') return this.tools['deep-search'].run({ q:user }, ctx)
    // default
    return this.tools['code-run'].run({ prompt:user }, ctx)
  }
}
```

**packages/agents/src/tools/docker.ts**
```ts
import { spawn } from 'node:child_process'
export default {
  name: 'docker',
  run: ({ image='giants/cli:local', task='quick-scan' }, { cwd, env }) => new Promise((res,rej)=>{
    const args = ['run','--rm','-v',`${cwd}:/work`,'-e',`GIANTS_TASK=${task}`, image]
    const p = spawn('docker', args, { env, cwd })
    let out=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d)
    p.on('close', c=> c===0?res({ok:true,out}):rej(new Error(out)))
  })
}
```

**packages/agents/src/tools/k8s.ts**
```ts
import { spawn } from 'node:child_process'
export default {
  name: 'k8s',
  run: ({ ns='giants', job='giants-run' }, { cwd, env }) => new Promise((res,rej)=>{
    const p = spawn('kubectl',['-n',ns,'create','job','--from=cronjob/giants-nightly', job+'-'+Date.now()],{ env,cwd })
    let out=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d)
    p.on('close', c=> c===0?res({ok:true,out}):rej(new Error(out)))
  })
}
```

**packages/agents/src/tools/deep-search.ts** (Platzhalter für „Research/Deep‑Search“)
```ts
export default {
  name: 'deep-search',
  async run({ q }: { q: string }){
    // Plug in deinen Search‑Dienst (z. B. interne API, Serper, Tavily, Bing, eigene Crawler)
    // return await fetch(SEARCH_URL, { method:'POST', headers:{'Authorization':`Bearer ${API_KEY}`}, body: JSON.stringify({ q }) }).then(r=>r.json())
    return { hits: [], note: 'deep-search connector placeholder' }
  }
}
```

**packages/agents/src/tools/rag.ts** (Minimal‑RAG auf Files)
```ts
import * as fs from 'fs/promises'
export default {
  name: 'rag',
  async run({ query }: { query: string }, { cwd }: { cwd: string }){
    // Dummy: durchsucht ./data/index.json (vorher erzeugt) nach Schlagworten
    try{
      const raw = await fs.readFile(`${cwd}/data/index.json`, 'utf8')
      const docs = JSON.parse(raw) as { id:string, text:string }[]
      const hits = docs.filter(d=> d.text.toLowerCase().includes(query.toLowerCase())).slice(0,5)
      return { hits }
    } catch { return { hits: [], note:'no index.json found' } }
  }
}
```

**packages/agents/src/tools/async-queue.ts** (Redis/BullMQ‑ready; hier nur Stub)
```ts
export default {
  name: 'async-queue',
  async run({ task }:{ task:string }){
    // Stub: In Produktion BullMQ/Redis oder SQLite‑Queue nehmen
    return { queued: true, id: Date.now(), task }
  }
}
```

**packages/agents/src/tools/code-run.ts**
```ts
export default { name:'code-run', async run({ prompt }:{prompt:string}){ return { echo: prompt } } }
```

**packages/agents/src/registry.ts**
```ts
import docker from './tools/docker'
import k8s from './tools/k8s'
import rag from './tools/rag'
import deep from './tools/deep-search'
import asyncq from './tools/async-queue'
import coder from './tools/code-run'
export const tools = { docker, 'k8s':k8s, 'rag':rag, 'deep-search':deep, 'async-queue':asyncq, 'code-run':coder }
```

**agents.config.json** (Profile: Lazy/Vibing/RAG/Async/Fetinch)
```json
{
  "coding_assistant": { "mode": "coding_assistant", "tools": ["code-run"] },
  "lazy_coding":     { "mode": "lazy_coding",     "tools": ["code-run","deep-search"] },
  "vibing_coding":   { "mode": "vibing_coding",   "tools": ["code-run"], "systemPrompt": "locker, ideenreich, knapp" },
  "rag_coding":      { "mode": "rag_coding",      "tools": ["rag","code-run"] },
  "async_coding":    { "mode": "async_coding",    "tools": ["async-queue","code-run"] },
  "research":        { "mode": "research",        "tools": ["deep-search","rag"] },
  "fetinch":         { "mode": "fetinch",         "tools": ["deep-search","async-queue","rag"], "systemPrompt": "experimentell, tiefe ketten, sandbox" }
}
```

---

## 4) RAG‑Index (Mini)

**scripts/rag-index.ts**
```ts
#!/usr/bin/env -S node --no-warnings
import * as fs from 'fs/promises'
import * as path from 'path'
const root = process.argv[2] || '.'
const out = process.argv[3] || './data/index.json'
const exts = new Set(['.md','.txt','.ts','.js','.py','.yaml','.yml'])
async function walk(dir:string, acc:any[]){
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
    const p = path.join(dir,e.name)
    if(e.isDirectory()) await walk(p,acc)
    else if(exts.has(path.extname(e.name))) acc.push({ id:p, text: await fs.readFile(p,'utf8') })
  }
}
(async()=>{ const acc:any[]=[]; await walk(root,acc); await fs.mkdir(path.dirname(out),{recursive:true}); await fs.writeFile(out,JSON.stringify(acc)); console.log('written', out, acc.length) })()
```

---

## 5) Makefile + GitHub Actions (Build & Release)

**Makefile**
```makefile
.PHONY: build docker helm
build:
	corepack enable || true
	pnpm -v || npm -v
	npm run build || true

docker:
	docker build -t giants/cli:local -f docker/Dockerfile .

helm:
	helm template helm/giants -f helm/giants/values.yaml
```

**.github/workflows/docker.yml** (Auszug)
```yaml
name: Docker
on: { push: { branches: [ main ] } }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - run: docker build -t ghcr.io/${{ github.repository }}/giants:latest -f docker/Dockerfile .
      - run: docker push ghcr.io/${{ github.repository }}/giants:latest
```

---

## 6) Quick‑Usage

**Docker lokal:**
```bash
docker compose -f docker/compose.yml up --build giants
```

**Kubernetes:**
```bash
kubectl apply -f k8s/01-namespace.yaml
kubectl apply -f k8s/02-configmap.yaml
kubectl apply -f k8s/03-secret.yaml
kubectl apply -f k8s/04-rbac.yaml
kubectl apply -f k8s/05-job.yaml
# Logs
kubectl -n giants logs job/giants-run
```

**Agent (Node):**
```ts
import { Agent } from './packages/agents/src/index'
import { tools } from './packages/agents/src/registry'
import cfg from './agents.config.json'
const agent = new Agent(cfg['rag_coding'] as any, tools as any)
agent.handle('Wie baue ich ein SBOM?', { cwd: process.cwd(), env: process.env }).then(console.log)
```

---

## 7) Notizen
- "Kubernetics" = **Kubernetes** (gleiche Suppe, nur wilder gewürzt). Ich nutze das korrekte API‑Schema.
- Deep‑Search ist absichtlich ein **Platzhalter** – du hängst deinen Suchdienst/API ein.
- `fetinch` ist als **Experiments‑Agent** gedacht: tiefe Ketten, RAG+Async, Sandbox.

Wenn du eine dieser Schienen „voll bauen“ willst (z. B. Helm‑Chart produktionsreif, BullMQ‑Worker mit Redis, oder Operator via Kopf/Go), sag mir die Zielumgebung – ich gieße es dir 1:1 in Code. 🔧🌌

