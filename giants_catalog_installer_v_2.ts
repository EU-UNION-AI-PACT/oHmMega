#!/usr/bin/env -S node --no-warnings
/**
 * giants-catalog-installer-v2.ts
 * ---------------------------------------------------------------------------
 * Generator für ein plattformübergreifendes "Giganten-Installation"-Setup.
 *
 * ✅ MCP-kompatible Kategorien (z. B. cli,tui,gui,sec,cloud,reveng,ai,docs,…)
 * ✅ 878+ Knoten / 99 Ebenen: Filter nach Gruppen & Ebenen, Topologiereihenfolge
 * ✅ Deduplizierung: global (id) und pro Paketmanager (case-insensitiv)
 * ✅ Connector-Exporte: apt/pacman/dnf/zypper/brew/cask/winget/choco/scoop/pipx/npm/cargo/go/flatpak
 * ✅ Installer: Linux/macOS (Bash) + Windows (Winget-Loop oder Choco)
 * ✅ Reports: giants-report.json (Zählungen, Duplikate, Gruppen, Ebenen)
 * ✅ Validierung: --expect-nodes, --expect-layers; bricht bei Abweichung ab
 *
 * Nutzung:
 *   node giants-catalog-installer-v2.ts \
 *     --catalog catalog.json \
 *     --groups cli,tui,gui,sec,cloud,reveng,ai \
 *     --layers 99 \
 *     --expect-nodes 878 \
 *     --expect-layers 99 \
 *     --outdir ./bootstrap \
 *     --windows winget \
 *     --optional pipx,npm,cargo,flatpak
 *
 * Katalog (Schema-Auszug):
 *   {
 *     "version": 1,
 *     "nodes": [
 *       {
 *         "id": "ripgrep",
 *         "title": "ripgrep",
 *         "groups": ["cli"],
 *         "layer": 1,
 *         "managers": {
 *           "apt": ["ripgrep"],
 *           "brew": ["ripgrep"],
 *           "winget": ["BurntSushi.ripgrep","ripgrep"]
 *         }
 *       }
 *     ]
 *   }
 */

import * as fs from 'fs/promises'
import * as path from 'path'

// ----------------------------- Types & Schemas -------------------------------

type Group = string // frei, z. B. 'cli','tui','gui','sec','cloud','reveng','ai','docs','sbom_license','accessibility'

type ManagerKey = 'apt'|'pacman'|'dnf'|'zypper'|'brew'|'cask'|'winget'|'choco'|'scoop'|'pipx'|'npm'|'cargo'|'go'|'flatpak'

interface NodeItem {
  id: string
  title?: string
  groups: Group[]
  layer: number // 1..99
  managers: Partial<Record<ManagerKey, string[]>>
}

interface Catalog { version: number; groups?: Group[]; nodes: NodeItem[] }

interface Opts {
  catalog: string
  groups: Group[]
  layers: number
  outdir: string
  windows: 'winget'|'choco'
  optional: ManagerKey[]
  expectNodes?: number
  expectLayers?: number
}

// ----------------------------- CLI Parsing -----------------------------------

function parseArgs(argv = process.argv.slice(2)): Opts {
  const get = (k: string, d?: string) => {
    const i = argv.findIndex(a => a === `--${k}` || a.startsWith(`--${k}=`))
    if (i === -1) return d
    const v = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i+1]
    return v ?? d
  }
  const csv = (s?: string) => (s ? s.split(',').map(x=>x.trim()).filter(Boolean) : [])
  const toInt = (s?: string) => (s==null?undefined:(parseInt(s,10)||undefined))
  return {
    catalog: get('catalog','catalog.json')!,
    groups: csv(get('groups','cli,tui,gui,sec,cloud,reveng,ai')),
    layers: Math.max(1, Math.min(99, parseInt(get('layers','99')!, 10) || 99)),
    outdir: path.resolve(get('outdir','./bootstrap')!),
    windows: (get('windows','winget') as 'winget'|'choco') || 'winget',
    optional: csv(get('optional','pipx,npm')) as ManagerKey[],
    expectNodes: toInt(get('expect-nodes')),
    expectLayers: toInt(get('expect-layers')),
  }
}

// ----------------------------- Helpers ---------------------------------------

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs))

function by<T>(arr: T[], key: (t: T)=>string) { const m = new Map<string,T>(); for (const a of arr) m.set(key(a), a); return m }

async function ensureDir(dir: string){ await fs.mkdir(dir, { recursive: true }); return dir }

function pushUniqueCase(set: Set<string>, arr: string[], name: string){
  const k = name.toLowerCase()
  if (!set.has(k)) { set.add(k); arr.push(name) }
}

function pushUniqueWinget(set: Set<string>, arr: string[], candidates: string[]){
  const key = candidates.map(s=>s.toLowerCase()).join(';')
  if (!set.has(key)) { set.add(key); arr.push(candidates.join(';')) }
}

// ----------------------------- Main Logic ------------------------------------

async function main(){
  const opts = parseArgs()
  await ensureDir(opts.outdir)
  const raw = await fs.readFile(opts.catalog, 'utf8')
  const cat = JSON.parse(raw) as Catalog

  if (!Array.isArray(cat.nodes)) throw new Error('Katalog ungültig: nodes[] fehlt')

  // Filter: Ebenen & Gruppen (falls groups leer, alles zulassen)
  const totalNodes = cat.nodes.length
  const filtered = cat.nodes
    .filter(n => n.layer >= 1 && n.layer <= opts.layers)
    .filter(n => opts.groups.length? n.groups?.some(g => opts.groups.includes(g)) : true)

  // Dedupe global via id, stabil in Layer-Reihenfolge
  const seenIds = new Set<string>()
  const ordered = filtered.sort((a,b)=> a.layer - b.layer)
  const nodes: NodeItem[] = []
  for (const n of ordered) { if (!seenIds.has(n.id)) { seenIds.add(n.id); nodes.push(n) } }

  // Validierungen
  if (opts.expectLayers && opts.layers !== opts.expectLayers) {
    throw new Error(`--layers (${opts.layers}) != --expect-layers (${opts.expectLayers})`)
  }
  if (opts.expectNodes && nodes.length !== opts.expectNodes) {
    throw new Error(`Auswahl hat ${nodes.length} Knoten, erwartet waren ${opts.expectNodes}`)
  }

  // Aggregate per manager mit Case-insensitiver Deduplizierung
  type Buckets = Record<ManagerKey, string[]>
  const buckets: Buckets = { apt:[], pacman:[], dnf:[], zypper:[], brew:[], cask:[], winget:[], choco:[], scoop:[], pipx:[], npm:[], cargo:[], go:[], flatpak:[] }
  const seen: Record<ManagerKey, Set<string>> = {
    apt:new Set(), pacman:new Set(), dnf:new Set(), zypper:new Set(), brew:new Set(), cask:new Set(),
    winget:new Set(), choco:new Set(), scoop:new Set(), pipx:new Set(), npm:new Set(), cargo:new Set(), go:new Set(), flatpak:new Set()
  }
  const preCounts: Record<ManagerKey, number> = { apt:0,pacman:0,dnf:0,zypper:0,brew:0,cask:0,winget:0,choco:0,scoop:0,pipx:0,npm:0,cargo:0,go:0,flatpak:0 }

  for (const n of nodes) {
    for (const mk of Object.keys(n.managers||{}) as ManagerKey[]) {
      const list = n.managers[mk] || []
      preCounts[mk] += list.length
      if (!list.length) continue
      if (mk === 'winget') {
        pushUniqueWinget(seen.winget, buckets.winget, list)
      } else {
        pushUniqueCase(seen[mk], buckets[mk], list[0])
      }
    }
  }

  // Installer schreiben
  await writeLinuxMacInstaller(opts, buckets)
  await writeWindowsInstaller(opts, buckets)

  // MCP-Kategorien (nur ausgewählte Gruppen)
  const mcp: Record<string,string[]> = {}
  for (const g of uniq(nodes.flatMap(n => n.groups))) {
    if (!opts.groups.length || opts.groups.includes(g)) {
      mcp[g] = uniq(nodes.filter(n => n.groups.includes(g)).map(n => n.id))
    }
  }
  await fs.writeFile(path.join(opts.outdir, 'giants-mcp-categories.json'), JSON.stringify({ mcp_categories: mcp }, null, 2), 'utf8')

  // Connectoren-Export
  const connectors = {
    version: 2,
    managers: {
      apt:    { cmd: 'sudo apt-get update -y && sudo apt-get install -y ${pkgs}', pkgs: buckets.apt },
      pacman: { cmd: 'sudo pacman -Sy --noconfirm ${pkgs}', pkgs: buckets.pacman },
      dnf:    { cmd: 'sudo dnf install -y ${pkgs}', pkgs: buckets.dnf },
      zypper: { cmd: 'sudo zypper --non-interactive install ${pkgs}', pkgs: buckets.zypper },
      brew:   { cmd: 'brew install ${pkgs}', pkgs: buckets.brew },
      cask:   { cmd: 'brew install --cask ${pkgs}', pkgs: buckets.cask },
      winget: { cmd: 'winget install (per Candidate-Loop in PS1)', pkgs: buckets.winget.map(s=>s.split(';')) },
      choco:  { cmd: 'choco upgrade -y ${pkgs}', pkgs: buckets.choco },
      scoop:  { cmd: 'scoop install ${pkgs}', pkgs: buckets.scoop },
      pipx:   { cmd: 'pipx install ${pkgs}', pkgs: buckets.pipx },
      npm:    { cmd: 'npm i -g ${pkgs}', pkgs: buckets.npm },
      cargo:  { cmd: 'cargo install ${pkgs}', pkgs: buckets.cargo },
      go:     { cmd: 'go install ${pkgs}', pkgs: buckets.go },
      flatpak:{ cmd: 'flatpak install -y ${pkgs}', pkgs: buckets.flatpak }
    }
  }
  await fs.writeFile(path.join(opts.outdir, 'giants-connectors.json'), JSON.stringify(connectors, null, 2), 'utf8')

  // Report schreiben
  const report = {
    totalNodes,
    filteredNodes: filtered.length,
    selectedNodes: nodes.length,
    groupsRequested: opts.groups,
    maxLayer: opts.layers,
    expectNodes: opts.expectNodes ?? null,
    expectLayers: opts.expectLayers ?? null,
    perManager: Object.fromEntries((Object.keys(buckets) as ManagerKey[]).map(k => [k, { before: preCounts[k], after: buckets[k].length }]))
  }
  await fs.writeFile(path.join(opts.outdir, 'giants-report.json'), JSON.stringify(report, null, 2), 'utf8')

  // README
  await fs.writeFile(path.join(opts.outdir, 'README.md'), renderReadme(opts), 'utf8')

  console.log(`\n[OK] Installer & Artefakte unter: ${opts.outdir}`)
}

// ----------------------------- Writers ---------------------------------------

function fmtList(xs: string[]) { return xs.join(' ') }

async function writeLinuxMacInstaller(opts: Opts, b: Record<ManagerKey,string[]>) {
  const sh = `#!/usr/bin/env bash\nset -euo pipefail\n\n# Autogeneriert von giants-catalog-installer-v2.ts\n# Gruppen: ${opts.groups.join(', ')} | Layers <= ${opts.layers}\n\nOS=$(uname -s || echo unknown)\nHAVE(){ command -v "$1" >/dev/null 2>&1; }\nlog(){ printf "\\n==> %s\\n" "$*"; }\nwarn(){ printf "[warn] %s\\n" "$*" >&2; }\ntry(){ "$@" || warn "$* (übersprungen)"; }\n\nPKG=''\nif [[ "$OS" == "Darwin" ]]; then\n  if ! HAVE brew; then\n    log "Installiere Homebrew…"\n    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.bash_profile" || true\n    eval "$(/opt/homebrew/bin/brew shellenv)"\n  fi\n  PKG=brew\nelse\n  if HAVE apt-get; then PKG=apt;\n  elif HAVE pacman; then PKG=pacman;\n  elif HAVE dnf; then PKG=dnf;\n  elif HAVE zypper; then PKG=zypper;\n  elif HAVE brew; then PKG=brew;\n  fi\nfi\n\ncase "$PKG" in\n  apt)    ${b.apt.length?`try sudo apt-get update -y; try sudo apt-get install -y ${fmtList(b.apt)}`:'true'} ;;;\n  pacman) ${b.pacman.length?`try sudo pacman -Sy --noconfirm ${fmtList(b.pacman)}`:'true'} ;;;\n  dnf)    ${b.dnf.length?`try sudo dnf install -y ${fmtList(b.dnf)}`:'true'} ;;;\n  zypper) ${b.zypper.length?`try sudo zypper --non-interactive install ${fmtList(b.zypper)}`:'true'} ;;;\n  brew)   ${b.brew.length?`try brew install ${fmtList(b.brew)}`:'true'} ;;;\n  *) warn "Kein unterstützter Paketmanager gefunden" ;;
 esac\n\n# macOS Casks\nif [[ "$PKG" == "brew" ]]; then\n  ${b.cask.length?`try brew install --cask ${fmtList(b.cask)}`:'true'}\nfi\n\n# Optionale Connectoren\n${b.pipx.length?`if HAVE python3; then if ! HAVE pipx; then try python3 -m pip install --user pipx && python3 -m pipx ensurepath; fi; try pipx install ${fmtList(b.pipx)}; fi`:'true'}\n${b.npm.length?`if HAVE npm; then try npm i -g ${fmtList(b.npm)}; fi`:'true'}\n${b.cargo.length?`if HAVE cargo; then try cargo install ${fmtList(b.cargo)}; fi`:'true'}\n${b.go.length?`if HAVE go; then try go install ${fmtList(b.go)}; fi`:'true'}\n${b.flatpak.length?`if HAVE flatpak; then try flatpak install -y ${fmtList(b.flatpak)}; fi`:'true'}\n\nlog "Fertig."\n`
  await fs.writeFile(path.join(opts.outdir, 'giants-install.sh'), sh, 'utf8')
  await fs.chmod(path.join(opts.outdir, 'giants-install.sh'), 0o755)
}

async function writeWindowsInstaller(opts: Opts, b: Record<ManagerKey,string[]>) {
  if (opts.windows === 'winget') {
    const ps = `param([string]$Groups = "${opts.groups.join(',')}")\n$ErrorActionPreference = 'SilentlyContinue'\nfunction Install-Candidates([string[]]$cands){ foreach($c in $cands){ try{ winget install --id $c -e -h --accept-package-agreements --accept-source-agreements; if($LASTEXITCODE -eq 0){ return $true } }catch{}; try{ winget install $c -e -h --accept-package-agreements --accept-source-agreements; if($LASTEXITCODE -eq 0){ return $true } }catch{} }; return $false }\n$WINGET = @()\n` + b.winget.map(s=>`$WINGET += ,@(${s.split(';').map(x=>`'${x}'`).join(',')})`).join('\n') + `\nforeach($cand in $WINGET){ Install-Candidates $cand | Out-Null }\nWrite-Host "Fertig."\n`
    await fs.writeFile(path.join(opts.outdir, 'giants-install-winget.ps1'), ps, 'utf8')
  } else {
    const ps = `Set-ExecutionPolicy Bypass -Scope Process -Force\n[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12\nif (-not (Get-Command choco -ErrorAction SilentlyContinue)) {\n  iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))\n}\nchoco upgrade -y ${fmtList(b.choco)}\n`
    await fs.writeFile(path.join(opts.outdir, 'giants-install-choco.ps1'), ps, 'utf8')
  }
}

function renderReadme(opts: Opts){
  return `# Giganten-Installation — Generator (v2)\n\nErzeugt universelle Installer-Skripte aus einem großen Katalog (878+ Knoten, 99 Ebenen).\n\n## Beispiel-Aufruf\n\n\nnode giants-catalog-installer-v2.ts \\\n  --catalog catalog.json \\\n  --groups ${opts.groups.join(',')} \\\n  --layers ${opts.layers} \\\n  --expect-nodes 878 \\\n  --expect-layers 99 \\\n  --outdir ./bootstrap \\\n  --windows ${opts.windows} \\\n  --optional pipx,npm,cargo,flatpak\n\n### Ausführen\n- Linux/macOS:  \n  \`./bootstrap/giants-install.sh\`\n- Windows (winget):  \n  \`powershell -ExecutionPolicy Bypass -File .\\bootstrap\\giants-install-winget.ps1\`\n\n## Artefakte\n- giants-install.sh / giants-install-winget.ps1\n- giants-mcp-categories.json — Gruppen → Node-IDs (für MCP Remote Server)\n- giants-connectors.json — Connector-Kommandos & deduplizierte Pakete je Manager\n- giants-report.json — Zählungen & Duplikat-Reduktion\n- README.md\n\n`}

// ----------------------------- Run -------------------------------------------

main().catch(e => { console.error('[ERR]', e.message || e); process.exit(1) })
