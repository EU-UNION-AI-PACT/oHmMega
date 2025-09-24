# Giganten‑Installation — Windows **WINGET** & MCP‑Kategorien

Dein universelles Setup bekommt jetzt extra Flügel: ein **Winget‑Installer** für Windows und ein **MCP Tool Remote Server**‑Mapping, das die Gruppen/Kategorien synchron hält.

---

## 🪟 Windows WINGET Installer (`giants-install-winget.ps1`)

```powershell
param(
  [string]$Groups = "cli,tui,gui,sec,cloud,reveng,ai"
)

# Best‑effort Installer mit winget. Probiert mehrere IDs/Namen je Tool.
# Nutzung:
#   powershell -ExecutionPolicy Bypass -File .\giants-install-winget.ps1 -Groups "cli,cloud,gui"

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

---

## 🧭 MCP Tool Remote Server — Kategorien & Mapping

Die Gruppen im Installer decken sich mit **MCP‑Kategorien** und können in Remote‑Servern genutzt werden (z. B. Feature‑Flags, Policy‑Driven Provisioning). Beispiel‑Mapping als `mcp-tool-categories.json`:

```json
{
  "mcp_categories": {
    "code_quality": ["eslint", "prettier", "bandit"],
    "security": ["nmap", "zaproxy", "trivy", "grype", "nuclei", "ffuf", "amass", "gitleaks", "kics", "tfsec", "conftest"],
    "cloud_k8s": ["kubectl", "helm", "k9s", "stern", "kind", "dive", "cosign", "syft", "grype", "trivy"],
    "ai_ml": ["mlflow", "label-studio", "netron", "onnxruntime-tools", "tflite-support", "graphviz"],
    "docs": ["typedoc", "swagger2markdown", "doxygen", "code2flow", "graphviz"],
    "sbom_license": ["syft", "cyclonedx", "scancode", "reuse"],
    "tui_rare": ["yazi", "xplr", "helix", "zellij", "broot", "gitui", "lazygit", "lazydocker", "duf", "gdu", "glow", "chafa", "viu", "navi", "dua-cli"],
    "gui_giants": ["Wireshark", "Ghidra", "Cutter", "DBeaver", "Insomnia", "Lens", "Netron", "ZAP"],
    "reveng": ["rizin", "radare2", "yara", "binwalk"],
    "accessibility": ["axe-core", "pa11y", "lighthouse"]
  }
}
```

**Nutzung im MCP‑Server**
- Lade die JSON und mappe Workspaces → Kategorien.
- Trigger pro Kategorie die passenden Installer (Bash/Winget).
- Optional: schreibe Audit‑Events (wer/wo/wann installiert wurde).

---

### Verknüpfung mit deinem macOS/Linux Installer
- Die Gruppennamen (`cli,tui,gui,sec,cloud,reveng,ai`) sind identisch.
- Beispiel Linux/macOS: `GIANTS_GROUPS="cli,cloud" ./giants-install.sh`
- Beispiel Windows: `powershell -EP Bypass -File .\giants-install-winget.ps1 -Groups "cli,gui,cloud"`

> **Hinweis:** Winget‑IDs können je nach Quelle variieren. Das Skript probiert mehrere Kandidaten; nicht verfügbare Pakete werden übersprungen (best effort).

