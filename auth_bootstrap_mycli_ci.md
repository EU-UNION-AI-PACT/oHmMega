# Auth Bootstrap — **mycli auth github|gitlab|npm** + CI

Sauberer, minimaler **Auth-Bootstrap** für deine CLI. Richtet GitHub/GitLab‑Logins (gh/glab), NPM‑Token (.npmrc) ein und prüft **SSH/HTTPS**‑Push.

> **Scope:** Nur „Auth‑Bootstrap“ (entspricht **B**). Enthält lauffähige CLI‑Skeletons + fertige CI‑Workflows (npm‑Release, Auto‑Commit).

---

## 📦 `packages/cli/package.json`
```json
{
  "name": "mycli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "mycli": "dist/index.js" },
  "scripts": {
    "build": "tsc -p .",
    "dev": "node --enable-source-maps dist/index.js",
    "start": "node dist/index.js",
    "lint": "echo 'lint stub'"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

## 🛠 `packages/cli/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

> Falls kein `tsconfig.base.json` existiert, kannst du diese Datei ohne `extends` nutzen.

---

## 🧭 `packages/cli/src/index.ts`
```ts
#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import os from 'node:os'

function die(msg: string, code = 1){ console.error(msg); process.exit(code) }
function has(cmd: string){ return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {stdio:'ignore'}).status === 0 }
function run(cmd: string, args: string[], opts: any = {}){
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  return r.status ?? 1
}

const [, , cmd, sub, ...rest] = process.argv
if (cmd !== 'auth' || !sub) {
  console.log(`\nmycli auth <github|gitlab|npm> [--repo <URL>] [--ssh <url>] [--https <url>]\n`)
  process.exit(0)
}

const repoArg = (()=>{
  const i = rest.indexOf('--repo');
  return i>=0? rest[i+1] : null
})()
const sshArg = (()=>{ const i = rest.indexOf('--ssh'); return i>=0? rest[i+1] : null })()
const httpsArg = (()=>{ const i = rest.indexOf('--https'); return i>=0? rest[i+1] : null })()

function gitRemoteUrl(kind: 'ssh'|'https'){
  if (kind==='ssh' && sshArg) return sshArg
  if (kind==='https' && httpsArg) return httpsArg
  // fallback: aus local repo lesen
  try{
    const r = spawnSync('git', ['remote','get-url','origin'], {encoding:'utf8'})
    const url = (r.stdout||'').trim()
    if (!url) return null
    if (kind==='ssh' && !url.startsWith('git@')){
      // heuristik für github
      const m = url.match(/github\.com[:/](.+)\.git$/)
      if (m) return `git@github.com:${m[1]}.git`
    }
    if (kind==='https' && url.startsWith('git@')){
      const mm = url.match(/git@([^:]+):(.+)\.git$/)
      if (mm) return `https://${mm[1]}/${mm[2]}.git`
    }
    return url
  }catch{ return null }
}

async function authGithub(){
  if (!has('gh')) die('gh CLI nicht gefunden. Installiere: https://cli.github.com/ oder `brew install gh` / `winget install GitHub.cli`')
  // Status & ggf. Login (Device Flow)
  const st = spawnSync('gh',['auth','status'], {stdio:'inherit'})
  if ((st.status??1) !== 0){
    console.log('\n→ GitHub Login (web)…')
    if (run('gh',['auth','login','--hostname','github.com','--git-protocol','https','--web']) !== 0) die('GitHub Login fehlgeschlagen')
  }
  // SSH‑Key optional
  const sshDir = path.join(os.homedir(), '.ssh')
  const key = path.join(sshDir, 'id_ed25519')
  if (!fs.existsSync(key)){
    console.log('→ Erzeuge SSH‑Key (ed25519)…')
    fs.mkdirSync(sshDir, {recursive:true})
    if (run('ssh-keygen', ['-t','ed25519','-N','', '-f', key]) !== 0) console.warn('[warn] ssh-keygen übersprungen')
    if (fs.existsSync(key + '.pub')) run('gh',['ssh-key','add','-t',`mycli-${Date.now()}`, key+'.pub'])
  }
  await verifyPushTargets('github.com')
}

async function authGitlab(){
  if (!has('glab')) die('glab CLI nicht gefunden. Installiere: https://gitlab.com/gitlab-org/cli')
  const st = spawnSync('glab',['auth','status'], {stdio:'inherit'})
  if ((st.status??1) !== 0){
    console.log('\n→ GitLab Login…')
    if (run('glab',['auth','login']) !== 0) die('GitLab Login fehlgeschlagen')
  }
  await verifyPushTargets('gitlab.com')
}

async function authNpm(){
  const npmToken = process.env.NPM_TOKEN
  const npmrc = path.resolve('.npmrc')
  if (npmToken){
    const line = `//registry.npmjs.org/:_authToken=${npmToken}\nregistry=https://registry.npmjs.org/\n`
    fs.writeFileSync(npmrc, line)
    console.log(`→ .npmrc geschrieben (${npmrc})`)
  } else {
    console.log('→ Interaktives npm login (optional). Setze alternativ NPM_TOKEN für CI-basierten Login).')
    run('npm',['login'])
  }
  // Probe
  const who = spawnSync('npm',['whoami'], {encoding:'utf8'})
  if ((who.status??1)===0) console.log(`npm ok: ${who.stdout.trim()}`)
  else console.warn('[warn] npm whoami fehlgeschlagen – prüfe Token/Login')
}

async function verifyPushTargets(hostHint?: string){
  const ssh = gitRemoteUrl('ssh')
  const https = gitRemoteUrl('https')
  if (ssh){ console.log(`→ Test SSH remote: ${ssh}`); const s = run('git',['ls-remote', ssh]); if (s===0) console.log('SSH ok') else console.warn('[warn] SSH Zugriff fehlgeschlagen') }
  if (https){ console.log(`→ Test HTTPS remote: ${https}`); const s = run('git',['ls-remote', https]); if (s===0) console.log('HTTPS ok') else console.warn('[warn] HTTPS Zugriff fehlgeschlagen') }
  if (!ssh && !https && hostHint) console.log(`Hinweis: kein origin gefunden. Erwarteter Host: ${hostHint}`)
}

(async ()=>{
  if (sub==='github')      await authGithub()
  else if (sub==='gitlab') await authGitlab()
  else if (sub==='npm')    await authNpm()
  else die('Unbekannter Provider. nutze: mycli auth <github|gitlab|npm>')
})().catch(e=>{ console.error(e); process.exit(1) })
```

---

## 🔐 Zusatz: Shell‑Helpers (optional)

### `scripts/setup-npmrc.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${NPM_TOKEN:?NPM_TOKEN fehlt}"
cat > .npmrc <<EOF
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
registry=https://registry.npmjs.org/
EOF
echo ".npmrc geschrieben"
```

### `scripts/check-remote.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
ssh_url=${1:-$(git remote get-url origin 2>/dev/null || true)}
https_url=${2:-}
if [[ "$ssh_url" == http* && -z "$https_url" ]]; then https_url="$ssh_url"; ssh_url=""; fi
[[ -n "$ssh_url" ]] && { echo "SSH: $ssh_url"; git ls-remote "$ssh_url" >/dev/null && echo ok || echo fail; }
[[ -n "$https_url" ]] && { echo "HTTPS: $https_url"; git ls-remote "$https_url" >/dev/null && echo ok || echo fail; }
```

---

## 🤖 CI — **GitHub Actions**

### `.github/workflows/npm-publish.yml`
```yaml
name: Publish NPM
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci --ignore-scripts
      - run: npm test --if-present
      - run: npm publish
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### `.github/workflows/auto-commit.yml`
```yaml
name: Auto Commit
on:
  workflow_dispatch: {}
  schedule:
    - cron: '17 4 * * *'
permissions:
  contents: write
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: true }
      - run: |
          git config user.name  'giants-bot'
          git config user.email 'bot@users.noreply.github.com'
          mkdir -p reports
          echo "heartbeat $(date -u +%FT%TZ)" >> reports/heartbeat.txt
          git add -A
          git commit -m 'chore(reports): heartbeat' || echo 'nothing to commit'
          git push
```

> **Secrets:** Für diesen Scope zwingend nur `NPM_TOKEN` (npm Publish). GitHub‑Login für lokale Entwickler per `gh auth login` (kein Secret nötig). Für Cross‑Repo‑Push optional `GH_PAT` (Scope `repo`).

---

## 🧪 Quick‑Test
```bash
# GitHub
mycli auth github --repo https://github.com/EU-UNION-AI-PACT/REPO.git
# GitLab
mycli auth gitlab --repo https://gitlab.com/GROUP/PROJECT.git
# npm (CI‑Stil)
NPM_TOKEN=*** mycli auth npm
```

**Fazit:** Ein Kommando, drei Wege: GitHub, GitLab, npm. Mit sichtbarer, sauberer Prüfung von SSH/HTTPS – und fertigen Workflows für Release & Auto‑Commit.

