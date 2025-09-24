# Giganten‑Installation — kuratierter Cross‑Platform Installer

Eine seltene, fette Sammlung von **CLI/GUI/TUI‑Giganten**, als direkt ausführbare Skripte für macOS, Linux und Windows. Best effort, fehlertolerant, kommentiert.

> **Lizenz/Etikette**: Security‑Tools (nmap, masscan, mitmproxy, nuclei, ffuf, amass, ZAP) **nur** auf eigenen/autorisierten Systemen verwenden.

---

## 🚀 Schnellstart

**macOS & Linux**
```bash
# 1) Speichere den Installer als giants-install.sh
chmod +x giants-install.sh
./giants-install.sh
```

**Windows (PowerShell als Administrator)**
```powershell
# 1) Speichere den Installer als giants-install.ps1
./giants-install.ps1
```

Optional: Kategorien steuern (nur macOS/Linux):
```bash
# Beispiel: nur CLI + TUI + Cloud
GIANTS_GROUPS="cli,tui,cloud" ./giants-install.sh
```

---

$1```bash
#!/usr/bin/env bash
# shellcheck shell=bash
# Giganten-Installation — macOS/Linux (Clean Code Edition)
# - Idempotent, fehlertolerant, ohne Bash-4-Features (läuft auch unter macOS Bash 3)
# - Gruppen via GIANTS_GROUPS steuern: cli,tui,gui,sec,cloud,reveng,ai

set -Eeuo pipefail

# ---------------------------- Logging & Helpers ----------------------------
info(){ printf "
==> %s
" "$*"; }
warn(){ printf "[warn] %s
" "$*" >&2; }
fail(){ printf "[err]  %s
" "$*" >&2; exit 1; }
HAVE(){ command -v "$1" >/dev/null 2>&1; }

trap 'warn "Fehler in Zeile $LINENO"' ERR

# ---------------------------- Konfiguration -------------------------------
# Standardgruppen; durch GIANTS_GROUPS=... überschreibbar
: "${GIANTS_GROUPS:=cli,tui,gui,sec,cloud,reveng,ai}"
# Lowercase + Trimmen
GIANTS_GROUPS=$(echo "$GIANTS_GROUPS" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
# want <gruppe>
want(){ case ",$GIANTS_GROUPS," in *",$1,"*) return 0;; *) return 1;; esac; }

# Kuratierte Pakete (Basisnamen)
CLI=( git curl wget jq yq ripgrep fd bat eza fzf zoxide hyperfine entr tree )
TUI=( btop bottom yazi xplr helix zellij broot gitui lazygit lazydocker dust duf procs gping gdu glow chafa viu navi dua-cli )
SEC=( nmap masscan mitmproxy nuclei ffuf amass owasp-zap )
CLOUD=( kubectl helm k9s stern kind dive cosign syft grype trivy tilt )
REVENG=( rizin radare2 yara binwalk )
AI=( graphviz )
GUI_CASKS=( wireshark ghidra cutter dbeaver-community insomnia lens netron owasp-zap )
GUI_APT=( wireshark dbeaver-ce )
GUI_DNF=( wireshark dbeaver )
GUI_PAC=( wireshark-qt dbeaver )

# Name-Mapping je Paketmanager (kein Bash-Associative-Array, damit macOS kompatibel)
adapt(){
  pm=$1; shift
  out=()
  for p in "$@"; do
    case "$pm:$p" in
      apt:fd|dnf:fd) p=fd-find ;;
      apt:eza|dnf:eza) p=exa ;;
      apt:gdu|pacman:gdu|dnf:gdu) p=gdu ;;
      apt:bottom) p=bottom ;;
      apt:dua-cli) p=dua-cli ;;
    esac
    out+=("$p")
  done
  printf '%s ' "${out[@]}"
}

# ---------------------------- Paketmanager erkennen -----------------------
OS=$(uname -s || echo unknown)
PKG=''
if [[ "$OS" == "Darwin" ]]; then
  if ! HAVE brew; then
    info "Installiere Homebrew…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo 'eval "$($(brew --prefix)/bin/brew shellenv)"' >> "$HOME/.bash_profile" || true
    # shellcheck disable=SC1090
    eval "$($(brew --prefix)/bin/brew shellenv)"
  fi
  PKG=brew
else
  if   HAVE apt-get; then PKG=apt
  elif HAVE pacman;  then PKG=pacman
  elif HAVE dnf;     then PKG=dnf
  elif HAVE zypper;  then PKG=zypper
  elif HAVE brew;    then PKG=brew
  fi
fi
[[ -z "$PKG" ]] && warn "Kein unterstützter Paketmanager gefunden (apt/pacman/dnf/zypper/brew)."

# ---------------------------- Install-Engine ------------------------------
install_group(){
  name=$1; shift; set +u; arr=("$@"); set -u; [[ ${#arr[@]} -eq 0 ]] && return 0
  case "$PKG" in
    apt)
      info "APT: $name"
      sudo apt-get update -y || true
      sudo apt-get install -y $(adapt apt "${arr[@]}") || warn "Teilmenge evtl. übersprungen"
      ;;
    pacman)
      info "pacman: $name"
      sudo pacman -Sy --noconfirm $(adapt pacman "${arr[@]}") || warn "Teilmenge evtl. übersprungen"
      ;;
    dnf)
      info "dnf: $name"
      sudo dnf install -y $(adapt dnf "${arr[@]}") || warn "Teilmenge evtl. übersprungen"
      ;;
    zypper)
      info "zypper: $name"
      sudo zypper --non-interactive install $(adapt zypper "${arr[@]}") || warn "Teilmenge evtl. übersprungen"
      ;;
    brew)
      info "brew: $name"
      brew install $(adapt brew "${arr[@]}") || warn "Teilmenge evtl. übersprungen"
      ;;
    *) warn "Unbekannter Paketmanager für $name" ;;
  esac
}

# ---------------------------- Ausführung nach Gruppen ---------------------
want cli   && install_group "CLI"              "${CLI[@]}"
want tui   && install_group "TUI"              "${TUI[@]}"
want sec   && install_group "Security"         "${SEC[@]}"
want cloud && install_group "Cloud/K8s"        "${CLOUD[@]}"
want reveng&& install_group "Reverse Eng."     "${REVENG[@]}"
want ai    && install_group "AI/ML Tooling"    "${AI[@]}"

# GUI je Plattform
if [[ "$OS" == "Darwin" ]]; then
  if want gui; then info "brew casks: GUI"; brew install --cask "${GUI_CASKS[@]}" || warn "Cask-Teilmenge übersprungen"; fi
else
  if want gui; then
    case "$PKG" in
      apt)    info "apt: GUI";    sudo apt-get install -y "${GUI_APT[@]}" || true ;;
      dnf)    info "dnf: GUI";    sudo dnf install -y      "${GUI_DNF[@]}" || true ;;
      pacman) info "pacman: GUI"; sudo pacman -Sy --noconfirm "${GUI_PAC[@]}" || true ;;
      *)      warn "GUI-Pakete für $PKG nicht hinterlegt. Flatpak/Snap erwägen." ;;
    esac
  fi
fi

# Optionale Python-CLIs via pipx
if HAVE python3; then
  if ! HAVE pipx; then python3 -m pip install --user pipx >/dev/null 2>&1 || true; python3 -m pipx ensurepath || true; fi
  for p in label-studio onnxruntime-tools tflite-support; do pipx install "$p" || true; done
fi

info "Fertig. Nicht verfügbare Pakete wurden übersprungen (best effort)."
```

---

$1```powershell
<#
  Giganten-Installation — Windows (Clean Code Edition)
  - Parameterisierte Gruppensteuerung
  - Winget → Chocolatey → Scoop (Fallback-Kaskade)
  - Kandidatenlisten je Paket (IDs/Namen)
#>
[CmdletBinding()]
param(
  [string]$Groups = "cli,tui,gui,sec,cloud,reveng,ai"
)
$ErrorActionPreference = 'SilentlyContinue'

function Has($n){ Get-Command $n -ErrorAction SilentlyContinue }
function Want($g){ ("," + $Groups.ToLower() + ",").Contains("," + $g.ToLower() + ",") }

function Ensure-Choco(){ if(!(Has choco)){ Write-Host 'Installiere Chocolatey…'; Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1')) } }
function Ensure-Scoop(){ if(!(Has scoop)){ iwr get.scoop.sh | iex }; scoop bucket add extras | Out-Null }

function Install-WithWinget([string[]]$cands){
  foreach($c in $cands){ try{ winget install --id $c -e -h --accept-package-agreements --accept-source-agreements; if($LASTEXITCODE -eq 0){ return $true } }catch{}; try{ winget install $c -e -h --accept-package-agreements --accept-source-agreements; if($LASTEXITCODE -eq 0){ return $true } }catch{} }
  return $false
}
function Install-WithChoco([string[]]$cands){ Ensure-Choco; foreach($c in $cands){ try{ choco upgrade -y $c; if($LASTEXITCODE -eq 0){ return $true } }catch{} } return $false }
function Install-WithScoop([string[]]$cands){ Ensure-Scoop; foreach($c in $cands){ try{ scoop install $c; if($LASTEXITCODE -eq 0){ return $true } }catch{} } return $false }

function Install-Any([string[]]$cands){ if(Has winget){ if(Install-WithWinget $cands){ return $true } }; if(Install-WithChoco $cands){ return $true }; if(Install-WithScoop $cands){ return $true }; Write-Warning ("Übersprungen: " + ($cands -join ', ')); return $false }

# Kandidaten-Mapping: Basisname → IDs/Namen
$Map = @{
  'git'=@('Git.Git','Git'); 'ripgrep'=@('BurntSushi.ripgrep','ripgrep'); 'fd'=@('sharkdp.fd','fd'); 'bat'=@('sharkdp.bat','bat');
  'fzf'=@('junegunn.fzf','fzf'); 'zoxide'=@('ajeetdsouza.zoxide','zoxide'); 'jq'=@('JQLang.jq','GnuWin32.jq','jq'); 'yq'=@('MikeFarah.yq','yq');
  'hyperfine'=@('sharkdp.hyperfine','hyperfine'); 'dust'=@('sharkdp.du-dust','dust'); 'eza'=@('eza-community.eza','eza','exa');
  'btop'=@('aristocratos.btop','btop'); 'yazi'=@('sxyazi.yazi','yazi'); 'xplr'=@('sayanarijit.xplr','xplr'); 'helix'=@('Helix.Helix','helix');
  'zellij'=@('ZellijOrg.Zellij','zellij'); 'broot'=@('Canop.Broot','broot'); 'gitui'=@('extrawurst.gitui','gitui'); 'lazygit'=@('jesseduffield.lazygit','lazygit'); 'lazydocker'=@('jesseduffield.lazydocker','lazydocker'); 'glow'=@('Peltoche.glow','glow');
  'nmap'=@('Insecure.Nmap','nmap'); 'mitmproxy'=@('mitmproxy.mitmproxy','mitmproxy'); 'nuclei'=@('ProjectDiscovery.Nuclei','nuclei'); 'ffuf'=@('ffuf.ffuf','ffuf'); 'amass'=@('OWASP.Amass','amass');
  'kubectl'=@('Kubernetes.kubectl','kubectl','kubernetes-cli'); 'helm'=@('Helm.Helm','helm','kubernetes-helm'); 'k9s'=@('derailed.k9s','k9s'); 'kind'=@('Kubernetes.kind','kind'); 'dive'=@('wagoodman.dive','dive'); 'cosign'=@('sigstore.cosign','cosign'); 'syft'=@('Anchore.Syft','syft'); 'grype'=@('Anchore.Grype','grype'); 'trivy'=@('AquaSecurity.Trivy','trivy');
  'radare2'=@('radareorg.radare2','radare2'); 'yara'=@('VirusTotal.yara','YARA','yara'); 'binwalk'=@('ReFirmLabs.binwalk','binwalk');
  'wireshark'=@('WiresharkFoundation.Wireshark','Wireshark'); 'ghidra'=@('NSA.Ghidra','ghidra'); 'dbeaver'=@('DBeaverCorp.DBeaver','DBeaver','DBeaverCE'); 'insomnia'=@('Kong.Insomnia','Insomnia'); 'lens'=@('Mirantis.Lens','Lens'); 'netron'=@('lutzroeder.netron','Netron')
}

# Gruppen (Basiskürzel)
$CLI   = @('git','curl','wget','jq','yq','ripgrep','fd','bat','eza','fzf','zoxide','hyperfine')
$TUI   = @('btop','yazi','xplr','helix','zellij','broot','gitui','lazygit','lazydocker','dust','duf','procs','gping','gdu','glow','chafa','viu','navi','dua-cli')
$SEC   = @('mitmproxy','nmap','nuclei','ffuf','amass')
$CLOUD = @('kubectl','helm','k9s','kind','dive','cosign','syft','grype','trivy')
$REV   = @('radare2','yara','binwalk')
$GUI   = @('wireshark','ghidra','dbeaver','insomnia','lens','netron')

function Install-Group($title, $items){
  Write-Host "`n==> $title"
  foreach($name in $items){ $cands = $Map[$name]; if(-not $cands){ $cands = @($name) }; Install-Any $cands | Out-Null }
}

if (Want 'cli')   { Install-Group 'CLI'               $CLI }
if (Want 'tui')   { Install-Group 'TUI'               $TUI }
if (Want 'sec')   { Install-Group 'Security'          $SEC }
if (Want 'cloud') { Install-Group 'Cloud/K8s'         $CLOUD }
if (Want 'reveng'){ Install-Group 'Reverse Engineering' $REV }
if (Want 'gui')   { Install-Group 'GUI'               $GUI }

Write-Host "`nFertig. Nicht verfügbare Pakete wurden übersprungen (best effort)."
```

---

## 💡 Hinweise
- Einige Pakete heißen je nach Distribution anders. Das Bash‑Skript mappt die gängigsten Unterschiede (z. B. `fd` → `fd-find`, `eza` → `exa`).
- **GUI unter Linux**: Wenn ein Paket in der Distro fehlt, nutze **Flatpak/Snap** oder Vendor‑Installer (z. B. Ghidra).
- **pipx** ergänzt seltene Python‑CLIs; falls nicht gewünscht, entferne die Zeilen.

Viel Spaß beim Aufrüsten. Dein Terminal wird danach wie ein Observatorium aussehen—Linsen, Spiegel, Spähernadeln. Und alles nur einen Befehl weit entfernt. 🌖🔭

