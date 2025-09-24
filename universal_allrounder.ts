#!/usr/bin/env -S node --experimental-modules --no-warnings
/**
 * UNIVERSAL-ALLROUNDER — Ein gigantisches Orchestrator-Skript für R&D, Dev, AI & Sec
 * -----------------------------------------------------------------------------------
 * Ziel: Ein einziges CLI-Skript, das eine große Bandbreite an Analysen, Scans,
 *       Checks und Reportings anstößt – best effort, modular, fehlertolerant.
 *
 * Quickstart (lokal):
 *   1) Node.js >= 18, Docker (optional), Python3 (optional) installieren
 *   2) Optional: Tools via Paketmanager/CLI bereitstellen (z. B. eslint, bandit, trivy ...)
 *   3) Dieses Skript ausführbar machen:  chmod +x universal-allrounder.ts
 *   4) Ausführen:                         ./universal-allrounder.ts --all --url https://example.org
 *
 * Beispiele:
 *   ./universal-allrounder.ts --category security --target . --max-parallel 4
 *   ./universal-allrounder.ts --only eslint,prettier,bandit --format md,json
 *   ./universal-allrounder.ts --all --write-config --exit-zero
 *   ./universal-allrounder.ts --all --llm review --openai-model gpt-4o-mini
 *
 * GitHub Actions (Beispiel):
 *   # .github/workflows/universal.yml
 *   # name: Universal Analyzer
 *   # on: [push, pull_request]
 *   # jobs:
 *   #   analyze:
 *   #     runs-on: ubuntu-latest
 *   #     steps:
 *   #       - uses: actions/checkout@v4
 *   #       - uses: actions/setup-node@v4
 *   #         with: { node-version: '20' }
 *   #       - name: Install optional CLIs
 *   #         run: |
 *   #           npm i -g eslint prettier @microsoft/rushstack-heft # beispielhaft
 *   #           pipx install bandit
 *   #           curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
 *   #       - name: Run Universal Allrounder
 *   #         run: |
 *   #           chmod +x ./universal-allrounder.ts
 *   #           ./universal-allrounder.ts --all --format json,md --target . --url ${{ secrets.SITE_URL }} --exit-zero
 *   #       - name: Upload Reports
 *   #         uses: actions/upload-artifact@v4
 *   #         with: { name: universal-reports, path: reports }
 *
 * Hinweise:
 *  - Das Skript versucht, installierte Tools automatisch zu erkennen. Fehlende Tools werden sauber übersprungen.
 *  - Exit-Code: standardmäßig EXIT 1 bei FAILED; mit --exit-zero immer EXIT 0.
 *  - Konfiguration: optional über universal.config.json (oder .yaml, wenn 'yaml' verfügbar ist) und Umgebungsvariablen.
 */

// ------------------------------ Imports & Types ------------------------------
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'

// Dynamisches YAML-Loading (optional)
let YAML: any = null
try {
  // @ts-ignore - optional dependency
  YAML = (await import('yaml')).default
} catch {}

// ------------------------------ Utility Helpers -----------------------------
const now = () => new Date().toISOString()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

const ensureDir = async (d: string) => {
  await fs.mkdir(d, { recursive: true })
  return d
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

const cut = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n…[trimmed ${s.length - n} chars]` : s)

const toArray = (v: any) => (Array.isArray(v) ? v : v == null ? [] : [v])

const human = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `${m}m ${r}s`
  const h = Math.floor(m / 60)
  const mr = m % 60
  return `${h}h ${mr}m`
}

// Cross-Platform which
async function which(cmd: string): Promise<string | null> {
  const isWin = process.platform === 'win32'
  const probe = isWin ? ['where', cmd] : ['bash', '-lc', `command -v ${cmd}`]
  try {
    const out = await runCmd(probe[0], probe.slice(1), { capture: true, timeoutMs: 10_000 })
    const p = out.stdout.trim().split(/\r?\n/)[0]
    return p ? p : null
  } catch {
    return null
  }
}

// Spawn helper
interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  capture?: boolean
  input?: string
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  cmdline: string
}

async function runCmd(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now()
  const child = spawn(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    shell: false,
    stdio: opts.capture ? 'pipe' : 'inherit',
  })

  let stdout = ''
  let stderr = ''
  const TO = setTimeout(() => {
    try { child.kill('SIGKILL') } catch {}
  }, opts.timeoutMs ?? 15 * 60 * 1000) // default 15min

  child.stdout?.on('data', d => (stdout += d.toString()))
  child.stderr?.on('data', d => (stderr += d.toString()))

  if (opts.input) child.stdin?.write(opts.input)
  child.stdin?.end()

  const code: number | null = await new Promise(resolve => child.on('close', resolve))
  clearTimeout(TO)

  return {
    code,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    cmdline: `${cmd} ${args.join(' ')}`.trim(),
  }
}

// Simple concurrency gate
class Gate {
  private queue: (() => void)[] = []
  private running = 0
  constructor(private limit: number) {}
  async acquire() {
    if (this.running < this.limit) { this.running++; return }
    await new Promise<void>(r => this.queue.push(r))
    this.running++
  }
  release() {
    this.running = Math.max(0, this.running - 1)
    const n = this.queue.shift(); if (n) n()
  }
}

// ------------------------------ CLI Args & Config ----------------------------
interface CliOptions {
  target: string
  url?: string
  image?: string
  categories: string[]
  only: string[]
  exclude: string[]
  format: ('json' | 'md')[]
  maxParallel: number
  exitZero: boolean
  writeConfig: boolean
  llm?: 'review' | 'doc' | 'off'
  openaiModel?: string
}

function parseArgs(argv = process.argv.slice(2)): CliOptions {
  const get = (key: string, def?: string) => {
    const i = argv.findIndex(a => a === `--${key}` || a.startsWith(`--${key}=`))
    if (i === -1) return def
    if (argv[i].includes('=')) return argv[i].split('=')[1]
    return argv[i + 1]
  }
  const has = (key: string) => argv.includes(`--${key}`)

  const only = get('only', '')!.split(',').filter(Boolean)
  const exclude = get('exclude', '')!.split(',').filter(Boolean)
  const cats = new Set<string>()
  if (has('all')) cats.add('all')
  const category = get('category')
  if (category) category.split(',').forEach(c => cats.add(c))

  const formats = get('format', 'json,md')!.split(',').filter(f => f === 'json' || f === 'md') as any

  return {
    target: path.resolve(get('target', '.').!),
    url: get('url') || process.env.TARGET_URL || undefined,
    image: get('image') || process.env.TARGET_IMAGE || undefined,
    categories: cats.size ? [...cats] : ['all'],
    only,
    exclude,
    format: formats.length ? formats : ['json', 'md'],
    maxParallel: clamp(parseInt(get('max-parallel', '4')!, 10) || 4, 1, 16),
    exitZero: has('exit-zero'),
    writeConfig: has('write-config'),
    llm: (get('llm', 'off') as any) || 'off',
    openaiModel: get('openai-model') || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  }
}

// Load optional config from file
async function loadConfig(target: string): Promise<Record<string, any>> {
  const candidates = [
    path.join(target, 'universal.config.json'),
    path.join(target, 'universal.config.yaml'),
    path.join(target, 'universal.config.yml'),
  ]
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      if (p.endsWith('.json')) return JSON.parse(raw)
      if (YAML && (p.endsWith('.yaml') || p.endsWith('.yml'))) return YAML.parse(raw)
    } catch {}
  }
  return {}
}

// ------------------------------ Task Types -----------------------------------

type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP' | 'INFO' | 'ERROR'

interface TaskContext {
  opts: CliOptions
  reportsDir: string
  workDir: string
  config: Record<string, any>
}

interface TaskResult {
  id: string
  title: string
  category: string
  status: Status
  exitCode: number | null
  durationMs: number
  artifacts: string[]
  stdout: string
  stderr: string
  hint?: string
  meta?: Record<string, any>
}

interface Task {
  id: string
  title: string
  category: string
  needs?: string[]
  inputs?: ('target' | 'url' | 'image')[]
  check?: (ctx: TaskContext) => Promise<boolean>
  run: (ctx: TaskContext) => Promise<TaskResult>
  hint?: string
}

// Helper to build standard CLI tasks
function cliTask(params: {
  id: string
  title: string
  category: string
  bin: string
  args: (ctx: TaskContext) => Promise<string[]>
  env?: (ctx: TaskContext) => Promise<Record<string, string>>
  requires?: (ctx: TaskContext) => Promise<string | null>
  timeoutMs?: number
  hint?: string
}): Task {
  return {
    id: params.id,
    title: params.title,
    category: params.category,
    inputs: ['target'],
    hint: params.hint,
    check: async () => !!(await which(params.bin)),
    run: async (ctx) => {
      if (params.requires) {
        const req = await params.requires(ctx)
        if (req) {
          return {
            id: params.id, title: params.title, category: params.category,
            status: 'SKIP', exitCode: 0, durationMs: 0, artifacts: [], stdout: '', stderr: '', hint: req,
          }
        }
      }
      const out = await runCmd(params.bin, await params.args(ctx), {
        cwd: ctx.opts.target, capture: true, timeoutMs: params.timeoutMs ?? 10 * 60 * 1000,
        env: params.env ? { ...(await params.env(ctx)) } : undefined,
      })
      const status: Status = out.code === 0 ? 'PASS' : 'FAIL'
      return {
        id: params.id, title: params.title, category: params.category,
        status, exitCode: out.code, durationMs: out.durationMs, artifacts: [], stdout: cut(out.stdout), stderr: cut(out.stderr),
        hint: params.hint,
      }
    }
  }
}

// ------------------------------ Task Registry --------------------------------

const tasks: Task[] = []

// --- Code Quality & Security ---
_tasks(() => {
  tasks.push(
    cliTask({
      id: 'eslint', title: 'ESLint', category: 'code-quality', bin: 'npx',
      args: async (ctx) => ['-y', 'eslint', '.', '-f', 'json', '-o', path.join(ctx.reportsDir, 'eslint.json')],
      hint: 'npm i -D eslint (@typescript-eslint/*) empfohlen',
    }),
    cliTask({
      id: 'prettier', title: 'Prettier Check', category: 'code-quality', bin: 'npx',
      args: async () => ['-y', 'prettier', '-c', '.'],
      hint: 'npm i -D prettier',
    }),
    cliTask({
      id: 'bandit', title: 'Bandit (Python Security)', category: 'security', bin: 'bandit',
      args: async (ctx) => ['-r', ctx.opts.target, '-f', 'json', '-o', path.join(ctx.reportsDir, 'bandit.json')],
      hint: 'pipx install bandit',
    }),
    // OWASP ZAP via Docker Baseline Scan
    {
      id: 'zap-baseline', title: 'OWASP ZAP Baseline (Docker)', category: 'security-web', inputs: ['url'],
      hint: 'Benötigt Docker und eine erreichbare URL',
      check: async () => !!(await which('docker')),
      run: async (ctx) => {
        const url = ctx.opts.url
        if (!url) return baseSkip('zap-baseline', 'OWASP ZAP Baseline', 'security-web', 'Kein --url angegeben')
        const reportHtml = path.join(ctx.reportsDir, 'zap-baseline.html')
        const out = await runCmd('docker', ['run', '-t', '--rm', '-v', `${ctx.reportsDir}:/zap/wrk:Z`, 'owasp/zap2docker-stable',
          'zap-baseline.py', '-t', url, '-r', '/zap/wrk/zap-baseline.html'], { capture: true, timeoutMs: 20 * 60 * 1000 })
        const status: Status = out.code === 0 ? 'PASS' : 'FAIL'
        return {
          id: 'zap-baseline', title: 'OWASP ZAP Baseline', category: 'security-web', status,
          exitCode: out.code, durationMs: out.durationMs, artifacts: [reportHtml], stdout: cut(out.stdout), stderr: cut(out.stderr),
          hint: 'Falls Site Auth benötigt: eigene ZAP-Konfiguration verwenden.',
        }
      }
    },
    // Trivy FS scan
    cliTask({
      id: 'trivy-fs', title: 'Trivy FS (Dependencies & Vulns)', category: 'security', bin: 'trivy',
      args: async (ctx) => ['fs', '--format', 'json', '--output', path.join(ctx.reportsDir, 'trivy-fs.json'), ctx.opts.target],
      hint: 'Install: https://aquasecurity.github.io/trivy',
    }),
    // Grype dir scan
    cliTask({
      id: 'grype-dir', title: 'Grype Dir Scan', category: 'security', bin: 'grype',
      args: async (ctx) => [`dir:${ctx.opts.target}`, '-o', 'json'],
      hint: 'Install: https://github.com/anchore/grype',
    }),
    // Gitleaks
    cliTask({
      id: 'gitleaks', title: 'Gitleaks (Secrets)', category: 'security', bin: 'gitleaks',
      args: async (ctx) => ['detect', '-s', ctx.opts.target, '-f', 'json', '-r', path.join(ctx.reportsDir, 'gitleaks.json')],
      hint: 'Install: https://github.com/gitleaks/gitleaks',
    }),
    // KICS IaC scan
    cliTask({
      id: 'kics', title: 'KICS (IaC SAST)', category: 'infrastructure', bin: 'kics',
      args: async (ctx) => ['scan', '-p', ctx.opts.target, '-o', path.join(ctx.reportsDir, 'kics'), '--report-formats', 'json,html'],
      hint: 'Install: https://github.com/Checkmarx/kics',
    }),
    // ansible-lint
    cliTask({
      id: 'ansible-lint', title: 'ansible-lint', category: 'infrastructure', bin: 'ansible-lint',
      args: async () => ['-p', '-f', 'json'],
      hint: 'pipx install ansible-lint',
    }),
  )
})

// --- License & Compliance ---
_tasks(() => {
  tasks.push(
    // ScanCode Toolkit
    cliTask({
      id: 'scancode', title: 'ScanCode Toolkit', category: 'license', bin: 'scancode',
      args: async (ctx) => ['-clp', '--json-pp', path.join(ctx.reportsDir, 'scancode.json'), ctx.opts.target],
      hint: 'Install: https://github.com/nexB/scancode-toolkit',
    }),
    // REUSE
    cliTask({
      id: 'reuse', title: 'REUSE Compliance', category: 'license', bin: 'reuse',
      args: async () => ['lint'],
      hint: 'pipx install reuse',
    }),
    // SBOM via Syft
    cliTask({
      id: 'syft', title: 'Syft SBOM (dir)', category: 'sbom', bin: 'syft',
      args: async (ctx) => [`dir:${ctx.opts.target}`, '-o', 'json', '-q', '-f', path.join(ctx.reportsDir, 'sbom-syft.json')],
      hint: 'Install: https://github.com/anchore/syft',
    }),
    // CycloneDX (Node)
    cliTask({
      id: 'cyclonedx-npm', title: 'CycloneDX SBOM (npm)', category: 'sbom', bin: 'npx',
      args: async (ctx) => ['-y', '@cyclonedx/cyclonedx-npm', '--output-file', path.join(ctx.reportsDir, 'bom-npm.json'), '--output-format', 'json'],
      hint: 'npm i -g @cyclonedx/cyclonedx-npm (oder lokal)',
    }),
  )
})

// --- Documentation & Knowledge Extraction ---
_tasks(() => {
  tasks.push(
    // TypeDoc (TS)
    cliTask({
      id: 'typedoc', title: 'TypeDoc (TS Doku)', category: 'docs', bin: 'npx',
      args: async (ctx) => ['-y', 'typedoc', '--json', path.join(ctx.reportsDir, 'typedoc.json')],
      hint: 'npm i -D typedoc',
    }),
    // Swagger/OpenAPI to Markdown
    cliTask({
      id: 'swagger2md', title: 'Swagger2Markdown', category: 'docs', bin: 'npx',
      args: async (ctx) => ['-y', 'swagger2markdown', '-i', resolveOpenApi(ctx), '-o', path.join(ctx.reportsDir, 'openapi.md')],
      requires: async (ctx) => (await resolveOpenApi(ctx)) ? null : 'Kein openapi.{yaml,yml,json} gefunden',
      hint: 'npm i -D swagger2markdown',
    }),
    // Doxygen, falls Doxyfile existiert
    {
      id: 'doxygen', title: 'Doxygen', category: 'docs',
      check: async () => !!(await which('doxygen')),
      run: async (ctx) => {
        const doxyfile = await fileIfExists(path.join(ctx.opts.target, 'Doxyfile'))
        if (!doxyfile) return baseSkip('doxygen', 'Doxygen', 'docs', 'Kein Doxyfile gefunden')
        const out = await runCmd('doxygen', [doxyfile], { cwd: ctx.opts.target, capture: true })
        return {
          id: 'doxygen', title: 'Doxygen', category: 'docs', status: out.code === 0 ? 'PASS' : 'FAIL',
          exitCode: out.code, durationMs: out.durationMs, artifacts: [], stdout: cut(out.stdout), stderr: cut(out.stderr),
        }
      }
    },
    // Code2Flow
    cliTask({
      id: 'code2flow', title: 'Code2Flow', category: 'docs', bin: 'code2flow',
      args: async (ctx) => [ctx.opts.target, '-o', path.join(ctx.reportsDir, 'code2flow.png')],
      hint: 'pipx install code2flow',
    }),
    // Graphviz (Beispiel: Abhängigkeitsgraph für package.json)
    {
      id: 'graphviz-npm', title: 'Graphviz (npm deps)', category: 'docs',
      check: async () => !!(await which('dot')),
      run: async (ctx) => {
        try {
          const pkgPath = path.join(ctx.opts.target, 'package.json')
          const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
          const deps = Object.keys({ ...(pkg.dependencies||{}), ...(pkg.devDependencies||{}) })
          const dot = 'digraph G {\n  rankdir=LR;\n  node [shape=box];\n' + deps.map(d => `  "${pkg.name}" -> "${d}";`).join('\n') + '\n}'
          const dotFile = path.join(ctx.reportsDir, 'deps.dot')
          const pngFile = path.join(ctx.reportsDir, 'deps.png')
          await fs.writeFile(dotFile, dot, 'utf8')
          const out = await runCmd('dot', ['-Tpng', dotFile, '-o', pngFile], { capture: true })
          return { id: 'graphviz-npm', title: 'Graphviz (npm deps)', category: 'docs', status: out.code===0?'PASS':'FAIL', exitCode: out.code, durationMs: out.durationMs, artifacts:[pngFile], stdout: cut(out.stdout), stderr: cut(out.stderr) }
        } catch (e: any) {
          return baseError('graphviz-npm', 'Graphviz (npm deps)', 'docs', e)
        }
      }
    },
  )
})

// --- Cloud-Integration & IaC ---
_tasks(() => {
  tasks.push(
    // Terraform JSON-Plan (falls terraform vorhanden)
    {
      id: 'terraform-plan-json', title: 'Terraform Plan (JSON)', category: 'infrastructure',
      check: async () => !!(await which('terraform')),
      run: async (ctx) => {
        try {
          // Init ignorieren, wenn kein Terraform-Projekt
          const tfFiles = await globExists(ctx.opts.target, ['**/*.tf'])
          if (!tfFiles) return baseSkip('terraform-plan-json', 'Terraform Plan (JSON)', 'infrastructure', 'Keine *.tf gefunden')
          await runCmd('terraform', ['init', '-input=false', '-no-color'], { cwd: ctx.opts.target, capture: true, timeoutMs: 10*60*1000 })
          const planOut = path.join(ctx.workDir, `tfplan-${hash(ctx.opts.target)}.bin`)
          await runCmd('terraform', ['plan', '-input=false', '-out', planOut, '-no-color'], { cwd: ctx.opts.target, capture: true, timeoutMs: 10*60*1000 })
          const jsonFile = path.join(ctx.reportsDir, 'terraform-plan.json')
          const out = await runCmd('terraform', ['show', '-json', planOut], { cwd: ctx.opts.target, capture: true })
          await fs.writeFile(jsonFile, out.stdout, 'utf8')
          return { id: 'terraform-plan-json', title: 'Terraform Plan (JSON)', category: 'infrastructure', status: out.code===0?'PASS':'FAIL', exitCode: out.code, durationMs: out.durationMs, artifacts:[jsonFile], stdout: cut(out.stdout), stderr: cut(out.stderr) }
        } catch (e: any) {
          return baseError('terraform-plan-json', 'Terraform Plan (JSON)', 'infrastructure', e)
        }
      }
    },
    // tfsec
    cliTask({ id: 'tfsec', title: 'tfsec', category: 'infrastructure', bin: 'tfsec', args: async (ctx)=>['--format','json','--out', path.join(ctx.reportsDir,'tfsec.json'), ctx.opts.target] }),
    // conftest/OPA
    cliTask({ id: 'conftest', title: 'Conftest (OPA)', category: 'infrastructure', bin: 'conftest', args: async (ctx)=>['test', '-o','json', ctx.opts.target], hint:'Install: https://www.conftest.dev/' }),
  )
})

// --- Testing & Coverage ---
_tasks(() => {
  tasks.push(
    cliTask({ id: 'pytest', title: 'pytest', category: 'testing', bin: 'pytest', args: async ()=>['-q', '--maxfail=1', '--disable-warnings'] }),
    cliTask({ id: 'jest', title: 'Jest', category: 'testing', bin: 'npx', args: async (ctx)=>['-y','jest','--json','--outputFile', path.join(ctx.reportsDir,'jest.json')] }),
    cliTask({ id: 'cypress', title: 'Cypress E2E', category: 'testing', bin: 'npx', args: async ()=>['-y','cypress','run'], hint:'Benötigt Headless-Umgebung in CI' }),
    cliTask({ id: 'playwright', title: 'Playwright', category: 'testing', bin: 'npx', args: async ()=>['-y','playwright','test','--reporter','json'] }),
    cliTask({ id: 'stryker', title: 'Stryker (Mutation)', category: 'testing', bin: 'npx', args: async ()=>['-y','stryker','run'] }),
    cliTask({ id: 'mutmut', title: 'mutmut (Mutation Py)', category: 'testing', bin: 'mutmut', args: async ()=>['run','--paths-to-mutate','.'] }),
  )
})

// --- Vulnerability Intelligence ---
_tasks(() => {
  tasks.push(
    cliTask({ id: 'osv-scanner', title: 'OSV Scanner', category: 'vuln-intel', bin: 'osv-scanner', args: async (ctx)=>['--recursive','.', '--json'], hint:'https://github.com/google/osv-scanner' }),
    // Abhängig von Image-Scan
    {
      id: 'trivy-image', title: 'Trivy Image', category: 'security',
      check: async () => !!(await which('trivy')),
      run: async (ctx) => {
        if (!ctx.opts.image) return baseSkip('trivy-image','Trivy Image','security','Kein --image angegeben')
        const out = await runCmd('trivy', ['image', '--format','json','--output', path.join(ctx.reportsDir,'trivy-image.json'), ctx.opts.image], { capture: true, timeoutMs: 20*60*1000 })
        return { id:'trivy-image', title:'Trivy Image', category:'security', status: out.code===0?'PASS':'FAIL', exitCode: out.code, durationMs: out.durationMs, artifacts:[path.join(ctx.reportsDir,'trivy-image.json')], stdout: cut(out.stdout), stderr: cut(out.stderr) }
      }
    },
  )
})

// --- Accessibility & UX ---
_tasks(() => {
  tasks.push(
    cliTask({ id: 'axe-core', title: 'axe-core (a11y)', category: 'accessibility', bin: 'npx', args: async (ctx)=>['-y','@axe-core/cli', ctx.opts.url || 'http://localhost:3000', '--save', path.join(ctx.reportsDir,'axe-results.json')], hint:'Benötigt laufende App/URL' }),
    cliTask({ id: 'pa11y', title: 'Pa11y', category: 'accessibility', bin: 'pa11y', args: async (ctx)=>[ctx.opts.url || 'http://localhost:3000', '--reporter','json'] }),
    cliTask({ id: 'lighthouse', title: 'Lighthouse', category: 'accessibility', bin: 'lighthouse', args: async (ctx)=>[ctx.opts.url || 'http://localhost:3000', '--output','json','--output-path', path.join(ctx.reportsDir,'lighthouse.json'), '--chrome-flags=--headless'] }),
  )
})

// --- AI/ML Model Analysis ---
_tasks(() => {
  tasks.push(
    // ONNX: onnxruntime-tools (wenn vorhanden)
    cliTask({ id: 'onnx-inspect', title: 'ONNX Inspector', category: 'ai-ml', bin: 'python3', args: async (ctx)=>['-c', "import onnx,sys,json; m=onnx.load(sys.argv[1]); print(json.dumps({'ir_version':m.ir_version,'producer':m.producer_name,'graphs':len(m.graph.node)}))", path.join(ctx.opts.target,'model.onnx')], requires: async (ctx)=> await fileIfExists(path.join(ctx.opts.target,'model.onnx'))?null:'Kein model.onnx gefunden', hint:'pip install onnx' }),
    // TF Lite: flatc dump (oder tflite-support)
    cliTask({ id: 'tflite-metadata', title: 'TFLite Metadata', category: 'ai-ml', bin: 'python3', args: async (ctx)=>['-c', "import sys,struct; d=open(sys.argv[1],'rb').read(); print('tflite-bytes',len(d))", path.join(ctx.opts.target,'model.tflite')], requires: async (ctx)=> await fileIfExists(path.join(ctx.opts.target,'model.tflite'))?null:'Kein model.tflite gefunden' }),
    // Model Card Generator (einfach)
    {
      id: 'model-card', title: 'Model Card Generator', category: 'ai-ml',
      run: async (ctx) => {
        try {
          const mc = `# Model Card\n\n- Generated: ${now()}\n- Project: ${path.basename(ctx.opts.target)}\n\n## Intended Use\nTBD\n\n## Performance & Bias\nTBD\n\n## Training Data\nTBD\n\n## Risks & Mitigations\nTBD\n`
          const outPath = path.join(ctx.reportsDir, 'model-card.md')
          await fs.writeFile(outPath, mc, 'utf8')
          return { id:'model-card', title:'Model Card Generator', category:'ai-ml', status:'INFO', exitCode:0, durationMs:0, artifacts:[outPath], stdout:'model card stub', stderr:'' }
        } catch (e:any){ return baseError('model-card','Model Card Generator','ai-ml', e) }
      }
    },
  )
})

// --- LLM / LangChain (leichtgewichtig) ---
_tasks(() => {
  tasks.push({
    id: 'llm-review', title: 'LLM Code Review (OpenAI)', category: 'ai-ml',
    check: async () => true,
    run: async (ctx) => {
      if (ctx.opts.llm !== 'review') return baseSkip('llm-review','LLM Code Review','ai-ml','--llm review nicht gesetzt')
      if (!process.env.OPENAI_API_KEY) return baseSkip('llm-review','LLM Code Review','ai-ml','OPENAI_API_KEY fehlt')
      try {
        const files = await listSmallTextFiles(ctx.opts.target)
        const payload = {
          model: ctx.opts.openaiModel,
          messages: [
            { role: 'system', content: 'Du bist ein präziser, knapper Sicherheits- und Code-Reviewer. Antworte in Deutsch.' },
            { role: 'user', content: 'Bitte gib 10 konkrete Verbesserungen (kurz) für diesen Code:\n' + files.slice(0,10).map(f=>`# ${path.relative(ctx.opts.target,f.path)}\n${f.content}`).join('\n\n') }
          ]
        }
        // Keine externe Abhängigkeit verwenden; einfache HTTPS-Request
        const res = await fetchJSON('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: {
            'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          }, body: JSON.stringify(payload)
        })
        const text = res?.choices?.[0]?.message?.content || 'Keine Antwort'
        const outPath = path.join(ctx.reportsDir, 'llm-review.md')
        await fs.writeFile(outPath, text, 'utf8')
        return { id:'llm-review', title:'LLM Code Review (OpenAI)', category:'ai-ml', status:'INFO', exitCode:0, durationMs:0, artifacts:[outPath], stdout: cut(text), stderr:'' }
      } catch (e:any) {
        return baseError('llm-review','LLM Code Review (OpenAI)','ai-ml', e)
      }
    }
  })
})

// --- Containers & Deployment ---
_tasks(() => {
  tasks.push(
    // Docker Build + Trivy scan (optional)
    {
      id: 'docker-build-scan', title: 'Docker Build + Trivy', category: 'containers',
      check: async () => !!(await which('docker')),
      run: async (ctx) => {
        const dockerfile = await fileIfExists(path.join(ctx.opts.target,'Dockerfile'))
        if (!dockerfile) return baseSkip('docker-build-scan','Docker Build + Trivy','containers','Kein Dockerfile gefunden')
        const tag = `ua-${hash(ctx.opts.target)}:latest`
        const build = await runCmd('docker', ['build','-t',tag,'.'], { cwd: ctx.opts.target, capture: true, timeoutMs: 30*60*1000 })
        if (build.code !== 0) return { id:'docker-build-scan', title:'Docker Build + Trivy', category:'containers', status:'FAIL', exitCode: build.code, durationMs: build.durationMs, artifacts:[], stdout: cut(build.stdout), stderr: cut(build.stderr) }
        const trivy = await which('trivy')
        if (!trivy) return { id:'docker-build-scan', title:'Docker Build + Trivy', category:'containers', status:'WARN', exitCode:0, durationMs:0, artifacts:[], stdout:'Build OK, Trivy nicht vorhanden', stderr:'' }
        const out = await runCmd(trivy, ['image','--format','json','--output', path.join(ctx.reportsDir,'trivy-image-from-build.json'), tag], { capture: true, timeoutMs: 20*60*1000 })
        return { id:'docker-build-scan', title:'Docker Build + Trivy', category:'containers', status: out.code===0?'PASS':'FAIL', exitCode: out.code, durationMs: out.durationMs, artifacts:[path.join(ctx.reportsDir,'trivy-image-from-build.json')], stdout: cut(out.stdout), stderr: cut(out.stderr) }
      }
    },
    // kubeval / kube-linter (falls vorhanden)
    cliTask({ id:'kubeval', title:'kubeval', category:'containers', bin:'kubeval', args: async (ctx)=>['--output','json', ...(await findFiles(ctx.opts.target,['**/*.yaml','**/*.yml'])).filter(f=>/k8s|kubernetes|deployment|service|ingress/i.test(f)).slice(0,50) ] }),
    cliTask({ id:'kube-linter', title:'kube-linter', category:'containers', bin:'kube-linter', args: async (ctx)=>['lint', ctx.opts.target, '--format','json'] }),
  )
})

// ------------------------------ Core Runner ----------------------------------

function _tasks(fn: () => void){ fn() }

function pickTasks(opts: CliOptions): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]))
  let sel: Task[]
  if (opts.only.length) sel = opts.only.map(id => byId.get(id)).filter(Boolean) as Task[]
  else if (opts.categories.includes('all')) sel = tasks
  else sel = tasks.filter(t => opts.categories.includes(t.category))
  if (opts.exclude.length) sel = sel.filter(t => !opts.exclude.includes(t.id))
  return sel
}

function baseSkip(id: string, title: string, category: string, why: string): TaskResult {
  return { id, title, category, status: 'SKIP', exitCode: 0, durationMs: 0, artifacts: [], stdout: '', stderr: '', hint: why }
}

function baseError(id: string, title: string, category: string, e: any): TaskResult {
  return { id, title, category, status: 'ERROR', exitCode: -1, durationMs: 0, artifacts: [], stdout: '', stderr: String(e?.stack || e), hint: 'Fehler beim Ausführen' }
}

async function ensureReports(): Promise<{ reportsDir: string, workDir: string }>{
  const reportsDir = await ensureDir(path.resolve('reports'))
  const workDir = await ensureDir(path.join(os.tmpdir(), `ua-${process.pid}`))
  return { reportsDir, workDir }
}

async function resolveOpenApi(ctx: TaskContext): Promise<string | null> {
  const cands = ['openapi.yaml','openapi.yml','openapi.json','swagger.yaml','swagger.yml']
  for (const f of cands) {
    const p = path.join(ctx.opts.target, f)
    if (await fileIfExists(p)) return p
  }
  return null
}

async function fileIfExists(p: string){ try { await fs.access(p); return p } catch { return null } }

async function globExists(root: string, globs: string[]): Promise<boolean> {
  for (const g of globs) {
    const files = await findFiles(root, [g], 1)
    if (files.length) return true
  }
  return false
}

async function findFiles(root: string, patterns: string[], limit = 9999): Promise<string[]> {
  // Sehr einfache Glob-Implementierung – ausreichend für *.tf, *.yaml etc.
  const res: string[] = []
  async function walk(dir: string){
    const ents = await fs.readdir(dir, { withFileTypes: true })
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name === 'node_modules' || e.name.startsWith('.git')) continue; await walk(p); continue }
      for (const pat of patterns) {
        if (matchGlob(p, pat)) { res.push(p); if (res.length >= limit) return }
      }
      if (res.length >= limit) return
    }
  }
  await walk(root)
  return res
}

function matchGlob(file: string, pattern: string): boolean {
  // sehr grob: **/*ext, *ext usw.
  const norm = file.replace(/\\/g,'/')
  const pat = pattern.replace(/\\/g,'/').replace(/[.+^${}()|\]/g,'\\$&').replace(/\*\*/g,'.*').replace(/\*/g,'[^/]*')
  const re = new RegExp('^' + pat + '$')
  return re.test(norm)
}

async function listSmallTextFiles(root: string, maxFiles = 50, maxBytes = 20_000){
  const files: { path: string, content: string }[] = []
  async function walk(dir: string){
    const ents = await fs.readdir(dir, { withFileTypes: true })
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name === 'node_modules' || e.name.startsWith('.git')) continue; await walk(p); if (files.length>=maxFiles) return }
      else {
        if (!/\.(ts|js|py|md|json|yml|yaml|tf|go|java|c|cpp|rs)$/i.test(p)) continue
        const stat = await fs.stat(p)
        if (stat.size > maxBytes) continue
        const content = await fs.readFile(p,'utf8')
        files.push({ path: p, content })
        if (files.length>=maxFiles) return
      }
    }
  }
  await walk(root)
  return files
}

async function fetchJSON(url: string, init: any): Promise<any> {
  const { request } = await import('node:https')
  const { URL } = await import('node:url')
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = init.body || ''
    const req = request({
      method: init.method || 'GET',
      hostname: u.hostname, path: u.pathname + (u.search||''), port: u.port || (u.protocol==='https:'?443:80),
      headers: init.headers || {},
    }, (res:any) => {
      let buf = ''
      res.on('data', (d:any)=> buf += d.toString())
      res.on('end', ()=>{
        try { resolve(JSON.parse(buf)) } catch(e){ reject(e) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ------------------------------ Reporting ------------------------------------

interface Summary {
  started: string
  finished: string
  options: CliOptions
  results: TaskResult[]
}

function renderMarkdown(sum: Summary): string {
  const head = `# Universal Allrounder Report\n\n- Started: ${sum.started}\n- Finished: ${sum.finished}\n- Target: ${sum.options.target}\n- URL: ${sum.options.url || '-'}\n- Image: ${sum.options.image || '-'}\n- Parallel: ${sum.options.maxParallel}\n\n`;
  const byCat = new Map<string, TaskResult[]>()
  for (const r of sum.results) {
    const a = byCat.get(r.category) || []
    a.push(r); byCat.set(r.category, a)
  }
  let body = ''
  for (const [cat, rs] of byCat) {
    body += `## ${cat}\n\n`
    for (const r of rs) {
      body += `### ${r.title} [${r.status}]\n`
      body += `- id: ${r.id}\n- duration: ${human(r.durationMs)}\n- exit: ${r.exitCode}\n- hint: ${r.hint || '-'}\n- artifacts: ${r.artifacts.map(a=>path.basename(a)).join(', ') || '-'}\n\n`
      if (r.stdout) body += `**stdout**\n\n\`\`\`\n${cut(r.stdout, 1200)}\n\`\`\`\n\n`
      if (r.stderr) body += `**stderr**\n\n\`\`\`\n${cut(r.stderr, 800)}\n\`\`\`\n\n`
    }
  }
  return head + body
}

// ------------------------------ Bootstrap: Installer-Generator -----------------

interface BootstrapOptions {
  packs: string[] // z.B. ['cli-giants','tui-rare','gui-giants','sec-blue','ai-ml','cloud-k8s','reveng','all']
  mode: 'write' | 'run' // 'write' erstellt Skripte in ./bootstrap, 'run' versucht sie auszuführen
}

function parseList(v?: string | null, def: string[] = []): string[] {
  if (!v) return def
  return v.split(',').map(s=>s.trim()).filter(Boolean)
}

function extendCliForBootstrap(orig: CliOptions){
  const argv = process.argv.slice(2)
  const get = (key: string, def?: string) => {
    const i = argv.findIndex(a => a === `--${key}` || a.startsWith(`--${key}=`))
    if (i === -1) return def
    if (argv[i].includes('=')) return argv[i].split('=')[1]
    return argv[i + 1]
  }
  const has = (key: string) => argv.includes(`--${key}`)
  const packs = parseList(get('bootstrap', ''))
  const mode = (get('bootstrap-mode','write') as 'write'|'run')
  return { ...orig, _bootstrapPacks: packs, _bootstrapMode: mode } as CliOptions & { _bootstrapPacks: string[], _bootstrapMode: 'write'|'run' }
}

// ——— Paketdefinitionen (bewusst kuratiert; fehlende Pakete werden tolerant behandelt)
const PACKS: Record<string, { brew?: string[]; apt?: string[]; pacman?: string[]; dnf?: string[]; choco?: string[]; scoop?: string[]; pipx?: string[]; npm?: string[]; notes?: string[]; casks?: string[] }> = {
  'cli-giants': {
    brew: ['git','curl','wget','jq','yq','ripgrep','fd','bat','eza','fzf','zoxide','hyperfine','entr','watchman'],
    apt:  ['git','curl','wget','jq','yq','ripgrep','fd-find','bat','eza','fzf','zoxide','hyperfine','entr'],
    pacman:['git','curl','wget','jq','yq','ripgrep','fd','bat','eza','fzf','zoxide','hyperfine','entr','watchman'],
    dnf:  ['git','curl','wget','jq','yq','ripgrep','fd-find','bat','exa','fzf','zoxide','hyperfine'],
    choco:['git','curl','wget','jq','yq','ripgrep','fd','bat','eza','fzf','zoxide','hyperfine'],
    scoop:['git','jq','yq','ripgrep','fd','bat','eza','fzf','zoxide','hyperfine'],
    npm:  [],
    pipx: [],
  },
  'tui-rare': {
    brew: ['btop','bottom','yazi','xplr','helix','zellij','broot','gitui','lazygit','lazydocker','dust','duf','procs','gping','gdu','glow','chafa','viu','navi','dua-cli'],
    apt:  ['btop','xplr','helix','zellij','gitui','lazygit','duf','procs','gdu','chafa'],
    pacman:['btop','bottom','yazi','xplr','helix','zellij','broot','gitui','lazygit','lazydocker','dust','duf','procs','gping','gdu','glow','chafa','viu','navi','dua-cli'],
    dnf:  ['btop','helix','zellij','gitui','lazygit','duf','procs','gdu','chafa'],
    choco:['btop.install','lazygit','duf','procs','glow','gitui','fzf'],
    scoop:['btop','yazi','xplr','helix','zellij','broot','gitui','lazygit','lazydocker','dust','duf','procs','gping','gdu','glow','chafa','viu','navi','dua-cli'],
  },
  'gui-giants': {
    // macOS via Homebrew Cask
    casks: ['wireshark','ghidra','cutter','dbeaver-community','insomnia','lens','netron','owasp-zap'],
    // Windows via Scoop/Choco
    choco: ['wireshark','ghidra','dbeaver','insomnia-rest-api-client','lens'],
    scoop: ['wireshark','ghidra','dbeaver','insomnia','lens','netron'],
    // Linux: GUIs sind je nach Distro unterschiedlich verfügbar – hier nur sichere Klassiker
    apt: ['wireshark','dbeaver-ce'],
    dnf: ['wireshark','dbeaver'],
    pacman: ['wireshark-qt','dbeaver'],
    pipx: ['netron','label-studio'],
  },
  'sec-blue': {
    brew: ['mitmproxy','nuclei','ffuf','amass','nmap','masscan','owasp-zap'],
    apt:  ['mitmproxy','nmap','masscan'],
    pacman:['mitmproxy','nuclei','ffuf','amass','nmap','masscan'],
    dnf:  ['mitmproxy','nmap','masscan'],
    choco:['mitmproxy','nmap'],
    scoop:['mitmproxy','nuclei','ffuf','amass','nmap'],
    notes:[
      '⚠️ Nutze diese Tools ausschließlich auf Systemen/Targets, für die du autorisiert bist.',
    ]
  },
  'ai-ml': {
    brew: ['dvc','graphviz'],
    apt:  ['graphviz'],
    pacman:['dvc','graphviz'],
    dnf:  ['graphviz'],
    pipx: ['mlflow','label-studio','onnxruntime-tools','tflite-support'],
    npm:  ['-g netron'],
  },
  'cloud-k8s': {
    brew: ['kubectl','helm','k9s','stern','kind','dive','cosign','syft','grype','trivy','tilt'],
    apt:  ['kubectl','helm','k9s'],
    pacman:['kubectl','helm','k9s','stern','kind','dive','cosign','syft','grype','trivy'],
    dnf:  ['kubectl','helm','k9s'],
    choco:['kubernetes-cli','k9s','kubernetes-helm','kind','dive'],
    scoop:['kubectl','k9s','helm','kind','dive','cosign','syft','grype','trivy'],
  },
  'reveng': {
    brew: ['rizin','radare2','yara','binwalk'],
    apt:  ['rizin','radare2','yara','binwalk'],
    pacman:['rizin','radare2','yara','binwalk'],
    dnf:  ['rizin','radare2','yara','binwalk'],
    choco:['rizin','radare2','yara','binwalk'],
    scoop:['rizin','radare2','yara','binwalk'],
  },
}

function uniq<T>(arr: T[]): T[]{ return Array.from(new Set(arr)) }

async function writeInstallers(packs: string[], baseDir: string){
  const outDir = path.join(baseDir, 'bootstrap')
  await ensureDir(outDir)
  const select = (field: keyof typeof PACKS['cli-giants']) => uniq(packs.flatMap(p => PACKS[p]?.[field] || []))

  const brew = select('brew')
  const casks = select('casks')
  const apt  = select('apt')
  const pac  = select('pacman')
  const dnf  = select('dnf')
  const choco= select('choco')
  const scoop= select('scoop')
  const pipx = select('pipx')
  const npmG = select('npm')
  const notes= select('notes')

  // macOS (brew)
  const mac = `#!/usr/bin/env bash
set -euo pipefail

which brew >/dev/null 2>&1 || /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"

BREW_PKGS=( ${brew.join(' ')} )
CASKS=( ${casks.join(' ')} )
[ ${brew.length} -gt 0 ] && brew install \
  ${brew.join(' ')} || true
[ ${casks.length} -gt 0 ] && brew install --cask \
  ${casks.join(' ')} || true

# Python CLIs via pipx
which pipx >/dev/null 2>&1 || python3 -m pip install --user pipx && python3 -m pipx ensurepath
${pipx.map(p=>`pipx install ${p} || true`).join('
')}
# Node global
${npmG.length?`npm ${npmG.join(' ')}`:''}
`
  await fs.writeFile(path.join(outDir, 'install-macos-brew.sh'), mac, 'utf8')

  // Ubuntu/Debian (apt)
  const linuxApt = `#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update -y || true
sudo apt-get install -y ${apt.join(' ')} || true
# Python CLIs
python3 -m pip install --user pipx || true
python3 -m pipx ensurepath || true
${pipx.map(p=>`pipx install ${p} || true`).join('
')}
# Node global
${npmG.length?`npm ${npmG.join(' ')} || true`:''}
`
  await fs.writeFile(path.join(outDir, 'install-linux-apt.sh'), linuxApt, 'utf8')

  // Arch (pacman)
  const arch = `#!/usr/bin/env bash
set -euo pipefail

sudo pacman -Sy --noconfirm ${pac.join(' ')} || true
python3 -m pip install --user pipx || true
python3 -m pipx ensurepath || true
${pipx.map(p=>`pipx install ${p} || true`).join('
')}
${npmG.length?`npm ${npmG.join(' ')} || true`:''}
`
  await fs.writeFile(path.join(outDir, 'install-linux-arch.sh'), arch, 'utf8')

  // Fedora (dnf)
  const fedora = `#!/usr/bin/env bash
set -euo pipefail

sudo dnf install -y ${dnf.join(' ')} || true
python3 -m pip install --user pipx || true
python3 -m pipx ensurepath || true
${pipx.map(p=>`pipx install ${p} || true`).join('
')}
${npmG.length?`npm ${npmG.join(' ')} || true`:''}
`
  await fs.writeFile(path.join(outDir, 'install-linux-dnf.sh'), fedora, 'utf8')

  // Windows (Chocolatey)
  const winChoco = `# requires Admin PowerShell
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))
}
choco upgrade -y ${choco.join(' ')}
`
  await fs.writeFile(path.join(outDir, 'install-windows-choco.ps1'), winChoco, 'utf8')

  // Windows (Scoop)
  const winScoop = `Set-ExecutionPolicy Bypass -Scope Process -Force
irm get.scoop.sh | iex
scoop bucket add extras
scoop install ${scoop.join(' ')}
`
  await fs.writeFile(path.join(outDir, 'install-windows-scoop.ps1'), winScoop, 'utf8')

  // README
  const readme = `# Bootstrap Installer

Dieses Verzeichnis enthält generierte Installer-Skripte für ausgewählte Tool-Packs.

## Packs
- ${Object.keys(PACKS).join('
- ')}

## Nutzung
### macOS
chmod +x install-macos-brew.sh && ./install-macos-brew.sh

### Ubuntu/Debian
chmod +x install-linux-apt.sh && ./install-linux-apt.sh

### Arch
chmod +x install-linux-arch.sh && ./install-linux-arch.sh

### Fedora
chmod +x install-linux-dnf.sh && ./install-linux-dnf.sh

### Windows
# Als Administrator in PowerShell
./install-windows-choco.ps1
# oder
./install-windows-scoop.ps1

## Hinweise
- Nicht alle Pakete existieren in jeder Distribution. Skripte sind tolerant (|| true).
- Sicherheits-Tools nur auf autorisierten Systemen einsetzen.
- Für GUIs unter Linux ggf. Flatpak/Snap nutzen oder Vendor-Downloads.
${notes.length?`
## Notizen
${notes.join('
')}`:''}
`
  await fs.writeFile(path.join(outDir, 'README.md'), readme, 'utf8')

  return outDir
}

async function maybeBootstrap(packs: string[], mode: 'write'|'run', baseDir: string){
  if (!packs.length) return null
  const outDir = await writeInstallers(packs, baseDir)
  if (mode === 'run') {
    // Best effort: starte passende Plattform-Skripte
    const plat = process.platform
    if (plat === 'darwin') await runCmd('bash', ['-lc', `chmod +x ${path.join(outDir,'install-macos-brew.sh')} && ${path.join(outDir,'install-macos-brew.sh')}`], { capture: true })
    else if (plat === 'win32') {
      // Nur generieren; Ausführung erfordert Admin – manuell starten
    } else {
      // Linux: versuche apt, sonst pacman, sonst dnf
      const tryApt = await which('apt-get')
      const tryPac = await which('pacman')
      const tryDnf = await which('dnf')
      if (tryApt) await runCmd('bash', ['-lc', `chmod +x ${path.join(outDir,'install-linux-apt.sh')} && ${path.join(outDir,'install-linux-apt.sh')}`], { capture: true })
      else if (tryPac) await runCmd('bash', ['-lc', `chmod +x ${path.join(outDir,'install-linux-arch.sh')} && ${path.join(outDir,'install-linux-arch.sh')}`], { capture: true })
      else if (tryDnf) await runCmd('bash', ['-lc', `chmod +x ${path.join(outDir,'install-linux-dnf.sh')} && ${path.join(outDir,'install-linux-dnf.sh')}`], { capture: true })
    }
  }
  return outDir
}

// ------------------------------ Main -----------------------------------------

;(async () => {
  const started = now()
  const opts = parseArgs()
  const { reportsDir, workDir } = await ensureReports()
  const config = await loadConfig(opts.target)

  if (opts.writeConfig) {
    const example = {
      url: opts.url || 'https://example.org',
      image: opts.image || 'alpine:latest',
      include: ['eslint','bandit','trivy-fs'],
      exclude: ['cypress'],
    }
    try { await fs.writeFile(path.join(opts.target, 'universal.config.json'), JSON.stringify(example, null, 2), 'utf8') } catch {}
  }

  const ctx: TaskContext = { opts, reportsDir, workDir, config }
  const selected = pickTasks(opts)

  // Filter by availability
  const available: Task[] = []
  for (const t of selected) {
    try { if (!t.check || (await t.check(ctx))) available.push(t) } catch {}
  }

  const gate = new Gate(opts.maxParallel)
  const results: TaskResult[] = []

  await Promise.all(available.map(async (t) => {
    await gate.acquire()
    const t0 = Date.now()
    try {
      const res = await t.run(ctx)
      results.push(res)
    } catch (e:any) {
      results.push(baseError(t.id, t.title, t.category, e))
    } finally {
      gate.release()
    }
  }))

  // Persist summary
  const summary: Summary = { started, finished: now(), options: opts, results }
  if (opts.format.includes('json')) await fs.writeFile(path.join(reportsDir, 'universal-report.json'), JSON.stringify(summary, null, 2), 'utf8')
  if (opts.format.includes('md')) await fs.writeFile(path.join(reportsDir, 'universal-report.md'), renderMarkdown(summary), 'utf8')

  // Console summary
  const stats = {
    PASS: results.filter(r=>r.status==='PASS').length,
    WARN: results.filter(r=>r.status==='WARN').length,
    FAIL: results.filter(r=>r.status==='FAIL').length,
    SKIP: results.filter(r=>r.status==='SKIP').length,
    INFO: results.filter(r=>r.status==='INFO').length,
    ERROR: results.filter(r=>r.status==='ERROR').length,
  }
  const total = results.length
  console.log(`\n=== Universal Allrounder Summary ===`)
  console.log(`Total: ${total} | PASS:${stats.PASS} WARN:${stats.WARN} FAIL:${stats.FAIL} SKIP:${stats.SKIP} INFO:${stats.INFO} ERROR:${stats.ERROR}`)
  console.log(`Reports: ${reportsDir}`)

  const failed = stats.FAIL + stats.ERROR
  if (failed > 0 && !opts.exitZero) process.exitCode = 1
})().catch(e => { console.error(e); process.exitCode = 1 })
