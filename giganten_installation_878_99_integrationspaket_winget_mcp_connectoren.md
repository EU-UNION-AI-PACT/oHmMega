# Giganten‑Installation — 878/99 Integrationspaket (Winget • MCP • Connectoren)

Dieses Paket ergänzt deinen vorhandenen **Cross‑Platform Installer** (Linux/macOS) um:
- einen **Windows‑Winget/PowerShell‑Installer**,
- **MCP‑Kategorien‑Mapping** (878 Knoten · 99 Ebenen · keine Duplikate),
- **Connector‑Exporte** für alle gängigen Paketmanager,
- **Validierung** gegen Zielgröße (878/99) und Report.

> Hinweis: Der Linux/macOS‑Teil liegt bereits in *„Giganten‑installation – Cross‑platform Installer“*. Hier bekommst du den Windows‑Winget‑Teil + MCP/Connector‑Artefakte zum direkten Andocken.

---

## 🪟 Windows **WINGET** Installer (`giants-install-winget.ps1`)

```powershell
param(
  [string]$Groups = "cli,tui,gui,sec,cloud,reveng,ai"
)

# Best‑effort Installer mit winget. Pro Tool werden mehrere IDs/Namen probiert.
# Beispiel:
# powershell -ExecutionPolicy Bypass -File .\giants-install-winget.ps1 -Groups "cli,cloud,gui"

$ErrorActionPreference = 'SilentlyContinue'
function Want($g){ return ("," + $Groups + ",").ToLower().Contains("," + $g.ToLower() + ",") }

function Install-Candidates([string[]]$cands) {
  foreach ($c in $cands) {
    try {
      winget install --id $c -e -h --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) { return $true }
    } catch {}
    try {
      winget install $c -e -h --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) { return $true }
    } catch {}
  }
  Write-Warning ("Übersprungen: " + ($cands -join ", "))
  return $false
}

$CLI = @(
  @('Git.Git','Git'),
  @('BurntSushi.ripgrep','ripgrep'),
  @('sharkdp.fd','fd'),
  @('sharkdp.bat','bat'),
  @('junegunn.fzf','fzf'),
  @('ajeetdsouza.zoxide','zoxide'),
  @('JQLang.jq','GnuWin32.jq','jq'),
  @('MikeFarah.yq','yq'),
  @('sharkdp.hyperfine','hyperfine'),
  @('sharkdp.du-dust','dust'),
  @('eza-community.eza','eza','exa')
)

$TUI = @(
  @('aristocratos.btop','btop'),
  @('sxyazi.yazi','yazi'),
  @('sayanarijit.xplr','xplr'),
  @('Helix.Helix','helix'),
  @('ZellijOrg.Zellij','zellij'),
  @('Canop.Broot','broot'),
  @('extrawurst.gitui','gitui'),
  @('jesseduffield.lazygit','lazygit'),
  @('jesseduffield.lazydocker','lazydocker'),
  @('Peltoche.glow','glow')
)

$SEC = @(
  @('Insecure.Nmap','nmap'),
  @('OWASPFoundation.OWASPZAP','OWASP ZAP','zap'),
  @('WiresharkFoundation.Wireshark','Wireshark'),
  @('mitmproxy.mitmproxy','mitmproxy'),
  @('ProjectDiscovery.Nuclei','nuclei'),
  @('ffuf.ffuf','ffuf'),
  @('OWASP.Amass','amass'),
  @('robertdavidgraham.masscan','masscan')
)

$CLOUD = @(
  @('Kubernetes.kubectl','kubectl'),
  @('Helm.Helm','helm'),
  @('derailed.k9s','k9s'),
  @('Kubernetes.kind','kind'),
  @('wagoodman.dive','dive'),
  @('sigstore.cosign','cosign'),
  @('Anchore.Syft','syft'),
  @('Anchore.Grype','grype'),
  @('AquaSecurity.Trivy','trivy')
)

$REVENG = @(
  @('radareorg.radare2','radare2'),
  @('NSA.Ghidra','ghidra'),
  @('VirusTotal.yara','YARA','yara'),
  @('ReFirmLabs.binwalk','binwalk')
)

$GUI = @(
  @('WiresharkFoundation.Wireshark','Wireshark'),
  @('NSA.Ghidra','ghidra'),
  @('DBeaverCorp.DBeaver','DBeaver','DBeaverCE'),
  @('Kong.Insomnia','Insomnia'),
  @('Mirantis.Lens','Lens'),
  @('lutzroeder.netron','Netron','lutzroeder.netron')
)

function Install-Group($name, $group) {
  Write-Host ("`n==> " + $name)
  foreach ($spec in $group) { Install-Candidates -cands $spec | Out-Null }
}

if (Want 'cli')   { Install-Group 'CLI' $CLI }
if (Want 'tui')   { Install-Group 'TUI' $TUI }
if (Want 'sec')   { Install-Group 'Security' $SEC }
if (Want 'cloud') { Install-Group 'Cloud/K8s' $CLOUD }
if (Want 'reveng'){ Install-Group 'Reverse Engineering' $REVENG }
if (Want 'gui')   { Install-Group 'GUI' $GUI }

Write-Host "`nFertig. Winget hat verfügbare Kandidaten installiert (best effort)."
```

> **Etikette**: Security‑Tools nur auf eigenen/autorisierten Systemen einsetzen.

---

## 🧭 MCP Tool Remote Server — Kategorien & Artefakte

### 1) Kategorien‑Mapping (Export)
Erzeugt beim Generatorlauf eine Datei `giants-mcp-categories.json`:
```json
{
  "mcp_categories": {
    "cli":    ["ripgrep", "fd", "bat"],
    "tui":    ["btop", "yazi", "helix"],
    "gui":    ["Wireshark", "Ghidra", "DBeaver"],
    "sec":    ["nmap", "zaproxy", "nuclei", "ffuf", "amass"],
    "cloud":  ["kubectl", "helm", "k9s", "kind", "trivy"],
    "reveng": ["radare2", "yara", "binwalk"],
    "ai":     ["mlflow", "label-studio", "netron"]
  }
}
```
> Dein realer Export enthält **alle 878 Knoten**, gefiltert nach Gruppen & Ebenen.

### 2) Connectoren (Export)
`giants-connectors.json` bündelt Paketmanager‑Kommandos + deduplizierte Pakete:
```json
{
  "version": 2,
  "managers": {
    "apt":    { "cmd": "sudo apt-get update -y && sudo apt-get install -y ${pkgs}", "pkgs": ["ripgrep","fd-find","eza"] },
    "brew":   { "cmd": "brew install ${pkgs}", "pkgs": ["ripgrep","fd","eza"] },
    "cask":   { "cmd": "brew install --cask ${pkgs}", "pkgs": ["wireshark","ghidra"] },
    "winget": { "cmd": "winget install (per Candidate-Loop)", "pkgs": [["BurntSushi.ripgrep","ripgrep"], ["eza-community.eza","eza","exa"]] }
  }
}
```

---

## 🔧 Generator (878/99 • No Duplicates • Reports)

Nutze den Generator aus dem Canvas (*giants-catalog-installer-v2.ts*). Er verarbeitet deinen `catalog.json` (878 Knoten · 99 Ebenen) und erzeugt Installer + Exporte.

**Beispielaufruf**
```bash
node giants-catalog-installer-v2.ts \
  --catalog catalog.json \
  --groups cli,tui,gui,sec,cloud,reveng,ai \
  --layers 99 \
  --expect-nodes 878 \
  --expect-layers 99 \
  --outdir ./bootstrap \
  --windows winget \
  --optional pipx,npm,cargo,flatpak
```

**Ausführen**
```bash
# Linux/macOS
./bootstrap/giants-install.sh
# Windows
powershell -ExecutionPolicy Bypass -File .\bootstrap\giants-install-winget.ps1 -Groups "cli,cloud,gui"
```

**Outputs**
- `giants-install.sh` (Linux/macOS)  ·  `giants-install-winget.ps1` (Windows)
- `giants-mcp-categories.json` · `giants-connectors.json` · `giants-report.json` · `README.md`

---

## 📦 Katalog‑Schema (Ausschnitt)
```json
{
  "version": 1,
  "nodes": [
    {
      "id": "ripgrep",
      "title": "ripgrep",
      "groups": ["cli"],
      "layer": 1,
      "managers": {
        "apt": ["ripgrep"],
        "brew": ["ripgrep"],
        "winget": ["BurntSushi.ripgrep", "ripgrep"]
      }
    }
  ]
}
```

**Validierung:** Der Generator bricht ab, wenn `--expect-nodes 878` oder `--expect-layers 99` nicht erfüllt sind. Duplikate werden global (per `id`) und pro Manager (case‑insensitiv) eliminiert.

---

Leitstern‑Modus: Linux/macOS links, Winget rechts, dazwischen MCP als Sternkarte. Du lieferst 878 Punkte — das Netz spannt sich von allein. 🌌

