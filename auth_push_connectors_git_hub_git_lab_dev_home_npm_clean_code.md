# Auth & Push Connectors — GitHub • GitLab • DevHome • npm (Clean Code)

Ziel: **sauber integrierte Auth & Push‑Pfade** für deine CLI/Monorepo. Fokus auf **Clean Code**, klare Zuständigkeiten und portable Skeletons.

---

## 0) Struktur
```
infra/
  auth/
    README.md
    local/
      setup-git-ssh.sh
      setup-gh.ps1
      setup-glab.ps1
    ci/
      github-actions-push.yml
      gitlab-ci-push.yml
  npm/
    .npmrc.template
    publish.yml
scripts/
  git-auto-push.sh
  git-auto-push.ps1
```

---

## 1) Lokale Auth (nutzerfreundlich & sicher)

### 1.1 GitHub – gh CLI (Device Flow, empfohlen)
`shell: infra/auth/local/setup-gh.ps1`
```powershell
# Requires: winget install GitHub.cli  (oder: brew install gh)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh CLI nicht gefunden' }
# Login (Device Code)
gh auth login --hostname github.com --git-protocol https --web
# Optional: SSH-Schlüssel erzeugen & hinterlegen
if (-not (Test-Path "$HOME/.ssh/id_ed25519")) { ssh-keygen -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519" }
$pub = Get-Content "$HOME/.ssh/id_ed25519.pub" -Raw
gh ssh-key add -t "giants-$(Get-Date -Format s)" -w "$pub"
```

### 1.2 GitLab – glab CLI
`shell: infra/auth/local/setup-glab.ps1`
```powershell
# winget install GitLab.Glab  (oder: brew install glab)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command glab -ErrorAction SilentlyContinue)) { throw 'glab CLI nicht gefunden' }
# Login (Device Flow / Token)
glab auth login
```

### 1.3 SSH (portabel; kein Token im Remote)
`shell: infra/auth/local/setup-git-ssh.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
key="$HOME/.ssh/id_ed25519"
[[ -f "$key" ]] || ssh-keygen -t ed25519 -N '' -f "$key"
eval "$(ssh-agent -s)" && ssh-add "$key"
# Hinweis: Public Key manuell bei GitHub/GitLab hinzufügen, falls nicht via gh/glab.
```

**Best Practices**
- **GCM** (Git Credential Manager) ist auf Windows/DevHome Standard – OAuth‑Login, sicherer Storage.
- Verwende **SSH** für dauerhafte lokale Arbeit, **HTTPS + Token** für CI‑Automatisierung.

---

## 2) Push aus CI/CD (gleicher Repo oder Cross‑Repo)

### 2.1 GitHub Actions – zurück in dasselbe Repo
`infra/auth/ci/github-actions-push.yml`
```yaml
name: Push Back
on:
  workflow_dispatch: {}
  push:
    paths: ["docs/**", "reports/**"]
permissions:
  contents: write   # GITHUB_TOKEN darf schreiben
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: true }
      - name: Konfigurieren
        run: |
          git config user.name  "giants-bot"
          git config user.email "bot@users.noreply.github.com"
          echo "Update: $(date -u)" >> reports/heartbeat.txt
          git add -A
          git commit -m "chore(reports): update" || echo "nichts zu committen"
          git push
```

### 2.2 GitHub Actions – in **anderes** Repo pushen (PAT)
```yaml
- name: Push to external repo
  env:
    GH_PAT: ${{ secrets.GH_PAT }}   # Scopes: repo, workflow
  run: |
    git config user.name  "giants-bot"
    git config user.email "bot@users.noreply.github.com"
    git remote add target https://x-access-token:${GH_PAT}@github.com/ORG/TARGET.git
    git push target HEAD:main
```

### 2.3 GitLab CI – zurück in dasselbe Projekt
`infra/auth/ci/gitlab-ci-push.yml`
```yaml
stages: [push]
push-back:
  image: alpine/git
  stage: push
  variables:
    GIT_STRATEGY: fetch
  script:
    - git config user.name  "giants-bot"
    - git config user.email "bot@example"
    - echo "Update: $(date -u)" >> reports/heartbeat.txt
    - git add -A && git commit -m "chore: update" || echo "skip"
    - git push https://oauth2:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git HEAD:$CI_COMMIT_REF_NAME
```

**Hinweise**
- **GitHub org SSO**: PAT im Org‑SSO freischalten, sonst 403.
- **Minimal‑Scopes**: GitHub `repo`, optional `workflow`; GitLab `api`/`write_repository`.

---

## 3) npm / GitHub Packages – Token & Publish

### 3.1 `.npmrc` (Template)
`infra/npm/.npmrc.template`
```ini
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
# GitHub Packages (optional, für @your-scope)
@your-scope:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

### 3.2 GitHub Action – Publish auf Tag
`infra/npm/publish.yml`
```yaml
name: Publish NPM
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', registry-url: 'https://registry.npmjs.org' }
      - run: npm ci
      - run: npm test --if-present
      - run: npm publish
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Scopes**
- npm: generiere `Automation`‑Token, beschränke auf „Publish“.
- GitHub Packages: `write:packages` + repo‑Zugriff.

---

## 4) DevHome (Windows) – bequeme Kopplung
- **Install**: `winget install Microsoft.DevHome` + `winget install GitHub.cli`
- In **Dev Home** → *Developer Accounts* → **GitHub verbinden** (OAuth/GCM).
- Repos direkt clonen auf **Dev Drive** (ReFS/NTFS mit Performance‑Profil).
- gh CLI übernimmt Token‑Refresh; Git Credential Manager speichert sicher.

---

## 5) Clean Push Scripts (lokal)

### 5.1 Bash
`scripts/git-auto-push.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
BRANCH=${1:-$(git rev-parse --abbrev-ref HEAD)}
USER=${GIT_USER:-giants-bot}
MAIL=${GIT_MAIL:-bot@users.noreply.github.com}
MSG=${GIT_MSG:-"chore: update"}

git config user.name  "$USER"
git config user.email "$MAIL"

# prefer GH_PAT, else GL_PAT
if [[ -n "${GH_PAT:-}" ]]; then
  url="https://x-access-token:${GH_PAT}@github.com/${GIT_REMOTE:-origin}.git"
elif [[ -n "${GL_PAT:-}" ]]; then
  url="https://oauth2:${GL_PAT}@${GL_HOST:-gitlab.com}/${GL_PATH:-group/project}.git"
else
  url=$(git remote get-url ${GIT_REMOTE:-origin})
fi

echo "Commit & Push → $BRANCH"
git add -A
(git commit -m "$MSG" || true)
[ -n "${url}" ] && git push "$url" HEAD:"$BRANCH" || git push ${GIT_REMOTE:-origin} HEAD:"$BRANCH"
```

### 5.2 PowerShell
`scripts/git-auto-push.ps1`
```powershell
param([string]$Branch)
$ErrorActionPreference = 'Stop'
if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD) }
$User = $env:GIT_USER  ?: 'giants-bot'
$Mail = $env:GIT_MAIL  ?: 'bot@users.noreply.github.com'
$Msg  = $env:GIT_MSG   ?: 'chore: update'

& git config user.name  $User
& git config user.email $Mail

if ($env:GH_PAT) { $url = "https://x-access-token:$($env:GH_PAT)@github.com/ORG/REPO.git" }
elseif ($env:GL_PAT) { $url = "https://oauth2:$($env:GL_PAT)@gitlab.com/GROUP/PROJECT.git" }
else { $url = (git remote get-url origin) }

& git add -A
try { & git commit -m $Msg } catch { Write-Host 'nichts zu committen' }
if ($url) { & git push $url "HEAD:$Branch" } else { & git push origin "HEAD:$Branch" }
```

---

## 6) Sicherheit & Compliance (Kurz)
- **Secret Storage:** GitHub *Actions Secrets* / *Environments*, GitLab *CI/CD Variables* (protected), lokale Tokens **nie committen**.
- **SSO/Org:** Tokens in Organisationen für SSO autorisieren.
- **Signieren:** `git config commit.gpgsign true` (GPG/SSH‑Sign), CI‑Bots mit Signer‑Key.
- **Least Privilege:** nur benötigte Scopes; Rotation halbjährlich.

---

## 7) Mini‑Checkliste
- [ ] gh/glab CLI installiert & eingeloggt
- [ ] SSH‑Key angelegt & hinterlegt
- [ ] CI‑Secrets: `GH_PAT`/`GL_PAT`/`NPM_TOKEN`
- [ ] `.npmrc` aus Template erzeugt
- [ ] Push‑Workflow aktiviert

---

Eleganz in drei Akten: **einloggen**, **signieren**, **schieben**. Der Rest ist Taktgefühl im Repo.

