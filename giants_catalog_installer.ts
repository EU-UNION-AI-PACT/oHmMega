#!/usr/bin/env -S node --no-warnings
/**
 * giants-catalog-installer.ts
 * ---------------------------------------------------------------------------
 * Generator für ein plattformübergreifendes "Giganten-Installation"-Setup.
 * - Liest einen Katalog (bis 8.8k+ Tools/Module, 99 Ebenen/Layers)
 * - Dedupliziert global & per Paketmanager
 * - Filtert nach Gruppen (MCP-Kategorien) und Layer-Grenze
 * - Schreibt ausführbare Installer-Skripte für Linux/macOS + Windows (winget)
 * - Exportiert MCP-kompatible Kategorien & Connector-Definitionen
 *
 * Nutzung (Beispiel):
 *   node giants-catalog-installer.ts \
 *     --catalog catalog.json \
 *     --groups cli,tui,gui,sec,cloud,reveng,ai \
 *     --layers 99 \
 *     --outdir ./bootstrap \
 *     --windows winget \
 *     --optional pipx,npm,cargo,flatpak
 *
 * Der Katalog muss mindestens Felder je Node enthalten: id, title, groups[], layer, managers{}
 */

import * as fs from 'fs/promises'
import * as path from 'path'

// ----------------------------- Types & Schemas -------------------------------

type Group = 'cli'|'tui'|'gui'|'sec'|'cloud'|'reveng'|'ai'|'docs'|'sbom_license'|'accessibility'|string

type ManagerKey = 'apt'|'pacman'|'dnf'|'zypper'|'brew'|'cask'|'winget'|'choco'|'scoop'|'pipx'|'npm'|'cargo'|'go'|'flatpak'

interface NodeItem {
  id: string               // kanonische ID (eindeutig, dedupe-key)
  title?: string           // Anzeigename
  groups: Group[]          // Kategorien (MCP-kompatibel)
  layer: number            // 1..99 (Install-Priorität/Abhängigkeitsebene)
  managers: Partial<Record<ManagerKey, string[]>> // Paketnamen je Manager (Kandidaten in Prioritätsreihenfolge)
}

interface Catalog {
  version: number
  groups: Group[]
  nodes: NodeItem[]
}

interface Opts {
  catalog: string
  groups: Group[]
  layers: number
  outdir: string
  windows: 'winget'|'choco'
  optional: ManagerKey[]
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
  const layers = Math.max(1, Math.min(99, parseInt(get('layers','99')!, 10) || 99))
  return {
    catalog: get('catalog','catalog.json')!,
    groups: csv(get('groups','cli,tui,gui,sec,cloud,reveng,ai')) as Group[],
    layers,
    outdir: path.resolve(get('outdir','./bootstrap')!),
    windows: (get('windows','winget') as 'winget'|'choco') || 'winget',
    optional: csv(get('optional','pipx,npm')) as ManagerKey[],
  }
}

// ----------------------------- Helpers ---------------------------------------

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs))

function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const o: Partial<T> = {}
  for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]
  return o
}

function by<T>(arr: T[], key: (t: T)=>string) { const m = new Map<string,T>(); for (const a of arr) m.set(key(a), a); return m }

function fmtList(xs: string[]) { return xs.join(' ') }

async function ensureDir(dir: string){ await fs.mkdir(dir, { recursive: true }); return dir }

// ----------------------------- Main Logic ------------------------------------

async function main(){
  const opts = parseArgs()
  await ensureDir(opts.outdir)
  const raw = await fs.readFile(opts.catalog, 'utf8')
  const cat = JSON.parse(raw) as Catalog

  // Validate minimal schema
  if (!Array.isArray(cat.nodes)) throw new Error('Katalog ungültig: nodes[] fehlt')

  // Filter by groups & layers, dedupe by id
  const selected = uniq(cat.nodes
    .filter(n => n.layer >= 1 && n.layer <= opts.layers)
    .filter(n => n.groups.some(g => opts.groups.includes(g)))
    .sort((a,b)=> a.layer - b.layer)
    .map(n => n.id))
  const byId = by(cat.nodes, n => n.id)
  const nodes = selected.map(id => byId.get(id)!).filter(Boolean)

  // Aggregate per manager with dedupe
  const buckets: Record<ManagerKey, string[]> = {
    apt:[], pacman:[], dnf:[], zypper:[], brew:[], cask:[], winget:[], choco:[], scoop:[], pipx:[], npm:[], cargo:[], go:[], flatpak:[]
  }

  for (const n of nodes) {
    for (const [mk, names] of Object.entries(n.managers) as [ManagerKey, string[]][]) {
      if (!names || names.length === 0) continue
      // Für winget behalten wir alle Kandidaten (zur Laufzeit probieren)
      if (mk === 'winget') {
        // packen als ";"-getrennte Kandidaten in einen Eintrag
        buckets[mk].push(names.join(';'))
      } else {
        // sonst nur den ersten Kandidaten bevorzugen
        buckets[mk].push(names[0])
      }
    }
  }
  for (const k of Object.keys(buckets) as ManagerKey[]) buckets[k] = uniq(buckets[k])

  // Write installers
  await writeLinuxMacInstaller(opts, buckets)
  await writeWindowsInstaller(opts, buckets)

  // Export MCP categories derived from catalog (only selected)
  const mcp: Record<string,string[]> = {}
  for (const g of opts.groups) {
    const ids = nodes.filter(n => n.groups.includes(g)).map(n => n.id)
    if (ids.length) mcp[g] = uniq(ids)
  }
  await fs.writeFile(path.join(opts.outdir, 'giants-mcp-categories.json'), JSON.stringify({ mcp_categories: mcp }, null, 2), 'utf8')

  // Export connectors (command templates + chosen packages)
  const connectors = {
    version: 1,
    managers: {
      apt: { cmd: 'sudo apt-get update -y && sudo apt-get install -y ${pkgs}', pkgs: buckets.apt },
      pacman: { cmd: 'sudo pacman -Sy --noconfirm ${pkgs}', pkgs: buckets.pacman },
      dnf: { cmd: 'sudo dnf install -y ${pkgs}', pkgs: buckets.dnf },
      zypper: { cmd: 'sudo zypper --non-interactive install ${pkgs}', pkgs: buckets.zypper },
      brew: { cmd: 'brew install ${pkgs}', pkgs: buckets.brew },
      cask: { cmd: 'brew install --cask ${pkgs}', pkgs: buckets.cask },
      winget: { cmd: 'winget install (per Candidate-Loop in PS1)', pkgs: buckets.winget.map(s=>s.split(';')) },
      choco: { cmd: 'choco upgrade -y ${pkgs}', pkgs: buckets.choco },
      scoop: { cmd: 'scoop install ${pkgs}', pkgs: buckets.scoop },
      pipx: { cmd: 'pipx install ${pkgs}', pkgs: opts.optional.includes('pipx') ? buckets.pipx : [] },
      npm: { cmd: 'npm i -g ${pkgs}', pkgs: opts.optional.includes('npm') ? buckets.npm : [] },
      cargo: { cmd: 'cargo install ${pkgs}', pkgs: opts.optional.includes('cargo') ? buckets.cargo : [] },
      go: { cmd: 'go install ${pkgs}', pkgs: opts.optional.includes('go') ? buckets.go : [] },
      flatpak: { cmd: 'flatpak install -y ${pkgs}', pkgs: opts.optional.includes('flatpak') ? buckets.flatpak : [] },
    }
  }
  await fs.writeFile(path.join(opts.outdir, 'giants-connectors.json'), JSON.stringify(connectors, null, 2), 'utf8')

  // README
  await fs.writeFile(path.join(opts.outdir, 'README.md'), renderReadme(opts), 'utf8')

  // Done
  console.log(`\n[OK] Installer erzeugt in: ${opts.outdir}`)
}

// ----------------------------- Writers ---------------------------------------

async function writeLinuxMacInstaller(opts: Opts, b: Record<ManagerKey,string[]>){
  const sh = `#!/usr/bin/env bash\nset -euo pipefail\n\n# Autogeneriert von giants-catalog-installer.ts\n# Gruppen: ${opts.groups.join(', ')} | Layers <= ${opts.layers}\n\nOS=$(uname -s || echo unknown)\nHAVE(){ command -v "$1" >/dev/null 2>&1; }\nlog(){ printf "\\n==> %s\\n" "$*"; }\nwarn(){ printf "[warn] %s\\n" "$*" >&2; }\ntry(){ "$@" || warn "$* (übersprungen)"; }\n\nPKG=''\nif [[ "$OS" == "Darwin" ]]; then\n  if ! HAVE brew; then\n    log "Installiere Homebrew…"\n    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.bash_profile" || true\n    eval "$(/opt/homebrew/bin/brew shellenv)"\n  fi\n  PKG=brew\nelse\n  if HAVE apt-get; then PKG=apt;\n  elif HAVE pacman; then PKG=pacman;\n  elif HAVE dnf; then PKG=dnf;\n  elif HAVE zypper; then PKG=zypper;\n  elif HAVE brew; then PKG=brew;\n  fi\nfi\n\ncase "$PKG" in\n  apt)    ${b.apt.length?`try sudo apt-get update -y; try sudo apt-get install -y ${fmtList(b.apt)}`:'true'} ;;;\n  pacman) ${b.pacman.length?`try sudo pacman -Sy --noconfirm ${fmtList(b.pacman)}`:'true'} ;;;\n  dnf)    ${b.dnf.length?`try sudo dnf install -y ${fmtList(b.dnf)}`:'true'} ;;;\n  zypper) ${b.zypper.length?`try sudo zypper --non-interactive install ${fmtList(b.zypper)}`:'true'} ;;;\n  brew)   ${b.brew.length?`try brew install ${fmtList(b.brew)}`:'true'} ;;;\n  *) warn "Kein unterstützter Paketmanager gefunden" ;;
 esac\n\n# macOS Casks\nif [[ "$PKG" == "brew" ]]; then\n  ${b.cask.length?`try brew install --cask ${fmtList(b.cask)}`:'true'}\nfi\n\n# Optionale Connectoren\n${b.pipx.length?`if HAVE python3; then if ! HAVE pipx; then try python3 -m pip install --user pipx && python3 -m pipx ensurepath; fi; try pipx install ${fmtList(b.pipx)}; fi`:'true'}\n${b.npm.length?`if HAVE npm; then try npm i -g ${fmtList(b.npm)}; fi`:'true'}\n${b.cargo.length?`if HAVE cargo; then try cargo install ${fmtList(b.cargo)}; fi`:'true'}\n${b.go.length?`if HAVE go; then try go install ${fmtList(b.go)}; fi`:'true'}\n${b.flatpak.length?`if HAVE flatpak; then try flatpak install -y ${fmtList(b.flatpak)}; fi`:'true'}\n\nlog "Fertig."\n`
  await fs.writeFile(path.join(opts.outdir, 'giants-install.sh'), sh, 'utf8')
  await fs.chmod(path.join(opts.outdir, 'giants-install.sh'), 0o755)
}

async function writeWindowsInstaller(opts: Opts, b: Record<ManagerKey,string[]>) {
  if (opts.windows === 'winget') {
    const ps = `param([string]$Groups = "${opts.groups.join(',')}")\n$ErrorActionPreference = 'SilentlyContinue'\nfunction Have($n){ Get-Command $n -ErrorAction SilentlyContinue }\nfunction Install-Candidates([string[]]$cands){ foreach($c in $cands){ try{ winget install --id $c -e -h --accept-package-agreements --accept-source-agreements; if($LASTEXITCODE -eq 0){ return $true } }catch{}; try{ winget install $c -e -h --accept-package-agreements --accept-source-agreements; if($LASTEXITCODE -eq 0){ return $true } }catch{} }; return $false }\n\n# Winget Pakete (Kandidatenlisten)\n$WINGET = @()\n` + b.winget.map(s=>`$WINGET += ,@(${s.split(';').map(x=>`'${x}'`).join(',')})`).join('\n') + `\nforeach($cand in $WINGET){ Install-Candidates $cand | Out-Null }\nWrite-Host "Fertig."\n`
    await fs.writeFile(path.join(opts.outdir, 'giants-install-winget.ps1'), ps, 'utf8')
  } else {
    const ps = `Set-ExecutionPolicy Bypass -Scope Process -Force\n[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12\nif (-not (Get-Command choco -ErrorAction SilentlyContinue)) {\n  iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))\n}\nchoco upgrade -y ${fmtList(b.choco)}\n`
    await fs.writeFile(path.join(opts.outdir, 'giants-install-choco.ps1'), ps, 'utf8')
  }
}

function renderReadme(opts: Opts){
  return `# Giganten-Installation — Generator\n\nErzeugt universelle Installer-Skripte aus einem großen Katalog (8.8k+ Tools, 99 Ebenen).\n\n## Nutzung\n\n```bash\nnode giants-catalog-installer.ts \\\n  --catalog catalog.json \\\n  --groups ${opts.groups.join(',')} \\\n  --layers ${opts.layers} \\\n  --outdir ./bootstrap \\\n  --windows ${opts.windows} \\\n  --optional pipx,npm,cargo,flatpak\n```\n\n### Ausführen\n- Linux/macOS:  \n  \`./bootstrap/giants-install.sh\`\n- Windows (winget):  \n  \`powershell -ExecutionPolicy Bypass -File .\\bootstrap\\giants-install-winget.ps1\`\n\n## Katalogschema\n\n\`catalog.json\` (Auszug):\n```json\n{\n  "version": 1,\n  "groups": ["cli","tui","gui","sec","cloud","reveng","ai"],\n  "nodes": [\n    {\n      "id": "ripgrep",\n      "title": "ripgrep",\n      "groups": ["cli"],\n      "layer": 1,\n      "managers": {\n        "apt": ["ripgrep"],\n        "pacman": ["ripgrep"],\n        "dnf": ["ripgrep"],\n        "brew": ["ripgrep"],\n        "winget": ["BurntSushi.ripgrep","ripgrep"],\n        "choco": ["ripgrep"]\n      }\n    }\n  ]\n}\n```\n\n- **layer**: 1..99, niedrigere Ebene wird zuerst installiert.\n- **managers**: Kandidaten je Paketmanager (erste Position = bevorzugt; winget nutzt alle Kandidaten).\n\n## Exporte\n- \`giants-mcp-categories.json\`: Gruppen → Node-IDs (für MCP Remote Server)\n- \`giants-connectors.json\`: Connector-Kommandos + final deduplizierte Pakete pro Manager\n\n## Deduplizierung\n- global via \`id\`,\n- pro Manager via Paketname (inkl. winget-Kandidatenlisten).\n\n`}

// ----------------------------- Run -------------------------------------------

main().catch(e => { console.error('[ERR]', e); process.exit(1) })
