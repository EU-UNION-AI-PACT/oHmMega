# IDE‑Connectoren — Skeletons für CLI‑Integration (selten & genial)

**Ziel:** Deine CLI (Standard: `giants`) in die gängigen und seltenen IDEs/Editoren einhängen. Alles **ohne** schwere Abhängigkeiten, sofort kopierbar.

**Kontrakt (empfohlen):**
- Binär/Script über `GIANTS_BIN` setzbar, Default `giants` im PATH.
- JSON‑Ausgabe (optional): `giants run --json --task <name>` → NDJSON/JSON.
- Exit‑Codes: 0=OK, 1=Warn/Soft‑Fail, >1=Error.

```json
{"ts":"2025-09-24T12:00:00Z","level":"info","msg":"start","task":"sbom"}
{"ts":"2025-09-24T12:00:03Z","level":"done","msg":"ok","artifacts":["reports/sbom.json"]}
```

---

## 0) Gemeinsame Dotfile (optional)
`giants.config.json` im Projektwurzelverzeichnis:
```json
{
  "bin": "giants",
  "defaultTask": "quick-scan",
  "args": ["--json"],
  "env": { "NO_COLOR": "1" }
}
```

Helper‑Shell (Unix): `scripts/giants-run.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
CFG=${1:-./giants.config.json}
BIN=$(jq -r '.bin // "giants"' "$CFG" 2>/dev/null || echo giants)
TASK=$(jq -r '.defaultTask // "quick-scan"' "$CFG" 2>/dev/null || echo quick-scan)
exec env $(jq -r '.env|to_entries|map("\(.key)=\(.value)")|join(" ")' "$CFG" 2>/dev/null) \
  "$BIN" run --json --task "$TASK" "${GIANTS_EXTRA_ARGS:-}"
```

---

## 1) **VS Code / Cursor** (Extension‑Skeleton)
**files:** `vscode-giants/package.json`, `vscode-giants/src/extension.ts`

**package.json**
```json
{
  "name": "giants-connector",
  "displayName": "Giants Connector",
  "publisher": "you",
  "version": "0.0.1",
  "engines": { "vscode": ">=1.85.0" },
  "activationEvents": ["onCommand:giants.run"],
  "contributes": {
    "commands": [{ "command": "giants.run", "title": "Giants: Run Default Task" }]
  },
  "main": "./dist/extension.js",
  "scripts": { "build": "tsc -p ." },
  "devDependencies": { "@types/vscode": "^1.85.0", "typescript": "^5.4.0" }
}
```

**src/extension.ts**
```ts
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export function activate(ctx: vscode.ExtensionContext){
  const run = vscode.commands.registerCommand('giants.run', async ()=>{
    const cfgPath = vscode.workspace.workspaceFolders?.[0]?.uri.with({path: vscode.workspace.workspaceFolders![0].uri.path + '/giants.config.json'});
    const cfg = cfgPath && fs.existsSync(cfgPath.fsPath) ? JSON.parse(fs.readFileSync(cfgPath.fsPath,'utf8')) : { bin:'giants', args:['--json'], defaultTask:'quick-scan' };
    const bin = process.env.GIANTS_BIN || cfg.bin || 'giants';
    const args = [...(cfg.args||[]), 'run','--task', cfg.defaultTask||'quick-scan'];

    const term = vscode.window.createTerminal({ name: 'Giants', env: cfg.env });
    term.show();
    term.sendText([bin, ...args].join(' '));

    const out = vscode.window.createOutputChannel('Giants');
    const p = spawn(bin, args, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, env: { ...process.env, ...(cfg.env||{}) } });
    p.stdout.on('data', d=> out.append(d.toString()));
    p.stderr.on('data', d=> out.append(d.toString()));
    p.on('close', code => vscode.window.showInformationMessage(`Giants finished (code ${code})`));
  });
  ctx.subscriptions.push(run);
}
export function deactivate(){}
```

**.vscode/tasks.json** (Alternative ohne Extension)
```json
{
  "version": "2.0.0",
  "tasks": [{
    "label": "Giants: Default Task",
    "type": "shell",
    "command": "${workspaceFolder}/scripts/giants-run.sh",
    "problemMatcher": []
  }]
}
```

---

## 2) **JetBrains IDEs** (IntelliJ/IDEA/Fleet kompatibel)
**files:** `jetbrains-giants/build.gradle.kts`, `jetbrains-giants/src/main/resources/META-INF/plugin.xml`, `GiantsAction.kt`

**build.gradle.kts (Ausschnitt)**
```kts
plugins { id("org.jetbrains.intellij") version "1.17.3"; kotlin("jvm") version "1.9.22" }
intellij { version.set("2024.1") }
dependencies { implementation(kotlin("stdlib")) }
```

**plugin.xml**
```xml
<idea-plugin>
  <id>giants.connector</id>
  <name>Giants Connector</name>
  <vendor email="you@dev">You</vendor>
  <description>Run Giants CLI from IDE.</description>
  <actions>
    <action id="Giants.Run" class="com.you.GiantsAction" text="Giants: Run Default Task"/>
  </actions>
</idea-plugin>
```

**GiantsAction.kt**
```kotlin
package com.you
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.io.File

class GiantsAction: AnAction(){
  override fun actionPerformed(e: AnActionEvent){
    val project: Project = e.project ?: return
    val root = project.basePath ?: "."
    val cfg = File(root, "giants.config.json")
    val (bin, task) = if (cfg.exists()) {
      val t = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper().readTree(cfg)
      Pair(System.getenv("GIANTS_BIN") ?: t.get("bin")?.asText() ?: "giants", t.get("defaultTask")?.asText() ?: "quick-scan")
    } else Pair(System.getenv("GIANTS_BIN") ?: "giants", "quick-scan")

    val pb = ProcessBuilder(bin, "run", "--json", "--task", task)
      .directory(File(root))
      .redirectErrorStream(true)
    val proc = pb.start()
    val out = proc.inputStream.bufferedReader().readText()
    val code = proc.waitFor()
    Messages.showInfoMessage(project, "Exit $code\n\n$out", "Giants")
  }
}
```

---

## 3) **Neovim (Lua)** — selten, schnell, genial
**files:** `lua/giants/init.lua`, `plugin/giants.lua`, `README.md`

**plugin/giants.lua**
```lua
vim.api.nvim_create_user_command('Giants', function(opts)
  local cfg = vim.fn.filereadable('giants.config.json') == 1 and vim.fn.json_decode(table.concat(vim.fn.readfile('giants.config.json'), '\n')) or {}
  local bin = os.getenv('GIANTS_BIN') or cfg.bin or 'giants'
  local task = cfg.defaultTask or 'quick-scan'
  local cmd = { bin, 'run', '--json', '--task', task }
  vim.fn.jobstart(cmd, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      if data then vim.fn.setqflist({}, ' ', { title='Giants', lines=data }) end
    end,
    on_exit = function(_, code)
      if code == 0 then vim.notify('Giants ok', vim.log.levels.INFO) else vim.notify('Giants exit '..code, vim.log.levels.ERROR) end
    end
  })
end, { nargs = 0 })

vim.keymap.set('n', '<leader>gr', ':Giants\n', { desc = 'Giants: Run Default Task' })
```

---

## 4) **Emacs (ELisp)** — seltene Liebhaber‑Edition
**file:** `giants.el`
```elisp
;;; giants.el --- Run Giants CLI from Emacs -*- lexical-binding: t; -*-
(defun giants-run ()
  (interactive)
  (let* ((cfg-file (expand-file-name "giants.config.json" default-directory))
         (cfg (when (file-readable-p cfg-file)
                (json-read-file cfg-file)))
         (bin (or (getenv "GIANTS_BIN") (alist-get 'bin cfg) "giants"))
         (task (or (alist-get 'defaultTask cfg) "quick-scan"))
         (buf (get-buffer-create "*Giants*")))
    (with-current-buffer buf (erase-buffer))
    (start-process "giants" buf bin "run" "--json" "--task" task)
    (pop-to-buffer buf)))
(global-set-key (kbd "C-c g r") #'giants-run)
(provide 'giants)
```

---

## 5) **Sublime Text (Python)** — rar & robust
**files:** `Packages/User/Giants.py`, `Packages/User/Giants.sublime-commands`

**Giants.py**
```python
import sublime, sublime_plugin, subprocess, json, os

class GiantsRunCommand(sublime_plugin.WindowCommand):
    def run(self):
        root = self.window.folders()[0] if self.window.folders() else os.getcwd()
        cfg_path = os.path.join(root, 'giants.config.json')
        cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
        bin = os.getenv('GIANTS_BIN') or cfg.get('bin','giants')
        task = cfg.get('defaultTask','quick-scan')
        p = subprocess.Popen([bin, 'run', '--json', '--task', task], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out, _ = p.communicate()
        panel = self.window.create_output_panel('giants')
        panel.run_command('append', {'characters': out.decode('utf-8', errors='ignore')})
        self.window.run_command('show_panel', {'panel': 'output.giants'})
```

**Giants.sublime-commands**
```json
[
  { "caption": "Giants: Run Default Task", "command": "giants_run" }
]
```

---

## 6) **Zed** — seltene Rakete (Tasks + Keymap)
**files:** `.zed/tasks.json`, `.zed/keymap.json`

**.zed/tasks.json**
```json
{
  "tasks": [
    { "label": "Giants: Run Default Task", "command": "sh", "args": ["-c", "scripts/giants-run.sh"] }
  ]
}
```

**.zed/keymap.json**
```json
[
  { "bindings": [ { "key": "ctrl-g r", "command": "tasks::run", "args": { "label": "Giants: Run Default Task" } } ] }
]
```

---

## 7) **Helix** — schlank & scharf
**file:** `~/.config/helix/config.toml`
```toml
[keys.normal]
"space" = { g = { r = ":sh scripts/giants-run.sh" } }
```

---

## 8) **Kakoune** — für Puristen
**file:** `~/.config/kak/kakrc`
```kak
map global normal <leader>gr ':nop %sh{ scripts/giants-run.sh }<ret>' -doc 'Giants: Run'
```

---

## 9) **Nova (macOS)** — Bonus‑exotisch (Task)
**files:** `.nova/tasks.json`
```json
{
  "tasks": [
    { "name": "Giants: Run Default Task", "action": "shell", "command": "scripts/giants-run.sh" }
  ]
}
```

---

## 10) **CLI → LSP‑Proxy (optional, smart)**
Wenn deine CLI Infos pro Datei liefert, kannst du einen **LSP‑Proxy** bauen, den IDEs nativ einbinden:

**files:** `packages/giants-lsp/server.ts`
```ts
import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { spawnSync } from 'node:child_process'

const conn = createConnection(ProposedFeatures.all)
const docs = new TextDocuments(TextDocument)
conn.onInitialize(()=>({ capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental } }))
docs.onDidChangeContent(e=>validate(e.document))

function validate(doc: TextDocument){
  const p = spawnSync(process.env.GIANTS_BIN||'giants', ['lint','--json','--file', doc.uri.replace('file://','')])
  const out = p.stdout?.toString()||'[]'
  const issues = JSON.parse(out) as { range:{start:number,end:number}, message:string, severity:"error"|"warning" }[]
  const diags: Diagnostic[] = issues.map(i=>({
    range: { start: doc.positionAt(i.range.start), end: doc.positionAt(i.range.end) },
    message: i.message,
    severity: i.severity==='error'? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source: 'giants'
  }))
  conn.sendDiagnostics({ uri: doc.uri, diagnostics: diags })
}

docs.listen(conn)
conn.listen()
```

Dann in **VS Code** `settings.json`:
```json
{
  "giants.lsp.enabled": true,
  "lsp.servers": {
    "giants": {
      "command": "node",
      "args": ["packages/giants-lsp/dist/server.js"],
      "filetypes": ["json","yaml","dockerfile","python","javascript","typescript"]
    }
  }
}
```

---

## Fertig – wie ein Schweizer Messer
- Alle Skeletons greifen auf **dieselbe** `giants.config.json` zu.
- `GIANTS_BIN` überschreibt den Pfad pro IDE/Session.
- Für CI/Automatisierung kannst du zusätzlich `scripts/giants-run.sh` direkt triggern.

Wenn du mir sagst, welche 2–3 IDEs du **zuerst** produktiv brauchst, gieße ich daraus sofort vollständige, baubare Pakete (manifest + build + icons).

