# dsh-plugin-workspace-discipline

English | [中文](README.zh.md)

A lightweight, local file-organisation plugin for **DeepSeek Harness (dsh)**.

It gives an agent one simple rule: **everything you produce goes into a project
folder inside the workspace** — never loose at the root, never in a temp folder
left behind. It also teaches the agent to keep reusable output in shared
libraries, and to write down what happened before a project is thrown away.

- **Platform:** DeepSeek Harness only. This is a dsh plugin and does nothing in
  any other harness.
- **Scope:** file layout and project hygiene. It does not touch models, tokens,
  network, or the UI.
- **Size:** one `index.js`, no dependencies, no build step.
- **How it enforces:** a prompt section plus a write guard. See
  [What it actually does](#what-it-actually-does) and
  [Risks and limitations](#risks-and-limitations) — the guard is a guardrail,
  **not** a security boundary.

> This plugin was designed and written mainly by an AI agent, working under a
> human owner's instructions. The behaviour is the result of many rounds of
> live testing on one machine, so it reflects that machine's habits closely.
> Judge it as one person's tool made public, not as a polished product.

---

## The idea

Agents are good at doing the work and bad at tidying up afterwards. A session
ends and the workspace is a heap of scratch files, half-finished folders, and
scripts that will be rewritten from scratch next time.

This plugin makes the tidy-up part of the job. Every session works inside a
project folder, and each folder says what state it is in:

```
<workspace>/
├── C-<name>/     completed, worth keeping
├── CW-<name>/    completed, disposable — safe to delete outright
├── T-<name>/     unfinished, still in progress
├── W-<name>/     abandoned — safe to delete outright
├── tools/        reusable scripts
├── skills/       reusable skills (SKILL.md)
├── mcp/          reusable MCP server definitions
└── log/          what a disposed project went through
```

The two-letter prefixes carry real meaning:

| Prefix | Finished? | Keep it? | Notes |
|---|---|---|---|
| `C-` | yes | yes | The default landing place. No `TEMP` folder inside. |
| `CW-` | yes | no | The result was obtained; the folder can go. No `TEMP` inside. |
| `T-` | no | — | Work in progress. May contain `TEMP`. |
| `W-` | no | no | Abandoned. Delete with no loss. |

`CW-` and `W-` are **reserved for the human**. The agent may create only `C-`
and `T-`; an attempt to open a new `CW-`/`W-` folder is refused, so an agent can
never quietly mark its own work as disposable.

## What it actually does

Three contributions, all registered by one plugin:

**1. A prompt section.** A description of the layout is injected into every
model step, not just once at session start. This is what keeps the rules from
drifting out of the model's view during a long session. The section is roughly
2–3 KB of text.

**2. A write guard.** Before a `write` or `edit` call runs, the target path is
checked. Out-of-place writes are refused with a message that says where the file
should go instead. It refuses:

- a file directly at the workspace root (a few metadata files are allowed),
- a loose file at a shared-library root instead of inside an entry folder,
- a folder name that does not start with a valid prefix,
- a `TEMP` path inside a `C-` or `CW-` project,
- creating a new `CW-` or `W-` folder,
- rewriting a library `README.md` in a way that loses its recorded history.

**3. A discovery tool.** `workspace_layout` lists the existing project folders
and the contents of every shared library, so the agent can continue an existing
folder instead of creating a duplicate, and can find reusable entries before
writing a new one.

## Renaming into CW-/W- is a prompt convention, not a block

This is the one part of the plugin that a guard **cannot** enforce, and it is
worth understanding before you rely on it.

The write guard refuses to *create* a `CW-` or `W-` folder. It cannot refuse a
**rename**: `Rename-Item`, `mv`, or any shell command moves a folder from `T-`
to `CW-` without passing through the guard at all. The plugin also has no
filesystem watcher, so it does not observe the rename afterwards.

What it does instead is instruct the model, in the injected prompt section, to
**name every folder and file it touched** whenever it renames a project into
`CW-`/`W-`, renames one back out, or deletes files inside one. The intent is
that a rename behaves like a permission change: you get an itemised list before
anything is deleted.

**This is a prompt-level convention, and prompts can be forgotten.** The
instruction is re-sent on every step, but a long session, an aggressive context
compaction, or a model that simply does not comply can drop it. There is no
failure, no error, and no refusal — the folder is already renamed and the
message simply does not say so.

**So please treat it that way:**

- **Before you rename anything into `CW-` or `W-`, be sure.** That kind says
  "this folder is disposable". Anything you still want is one careless delete
  away from being gone.
- **Check what actually changed yourself** rather than trusting a summary. A
  short list in the reply is a helpful courtesy, not a guarantee that it is
  complete.
- **Deleting a `CW-` or `W-` folder deserves the most care of all.** There is no
  undo, and the plugin never deletes anything for you — the decision and the
  deletion are yours.
- If an agent reports "done" without a list, ask it for one explicitly before you
  delete anything.

If you want a hard rule instead of a convention, do not rename folders through
the agent at all — rename them yourself, and keep the agent's writes inside
`C-`/`T-` where the guard still applies.

## Install

```bash
dsh plugin --profile <profile> add <package-name>
```

Or install from a local checkout, which is what development looks like: ask the
agent to call `plugin_manager` with `install_bundle` and the absolute path to
the package directory. The profile stores it as a `link:` dependency.

After installing, enable the bundle if the profile leaves it disabled, then
restart dsh so the bundle is re-included.

`engines.dsh` declares `>=0.2.1-rc.3`. This is the version it was tested on, not
a hard promise about future ones.

## Usage

Nothing to invoke. Once the plugin is active, every session follows the layout.

If the session's working directory **is** your workspace, no configuration is
needed at all — the plugin enforces whatever directory the session is in.

If your workspace is a *parent* of the session directory (for example the
session starts in `<workspace>/some-subfolder` while the projects live at
`<workspace>`), set the root explicitly:

```yaml
- insert:
    - id: workspace-discipline
      name: 'dsh-plugin-workspace-discipline'
      config:
        roots:
          - '/absolute/path/to/your/workspace'
        strict: true
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Workspace root(s) to enforce. Empty means "the session's own directory". |
| `libraries` | `['tools','skills','mcp','log']` | Folder names treated as shared libraries beside the projects. |
| `ignore` | `[]` | Root-relative path prefixes exempt from the guard, for legacy trees that predate the convention. Matching is segment-aware: `legacy` exempts `legacy/...` but not `legacy2/...`. |
| `strict` | `true` | `false` disables the write guard while keeping the prompt section and the tool. |

## Risks and limitations

Read this before installing. These are real, not disclaimers.

**It costs context on every step.** The prompt section is injected into each
model step, not once per session. It is a few KB of text, and it does not
disappear when the conversation is compacted. On a long session this is a
steady, non-zero cost.

**Shared libraries cost context too.** The more tools, skills, MCP entries and
log entries you accumulate, the more there is to read before starting work. A
workspace with fifty tool READMEs is not cheap to work in. The plugin
encourages reuse, and reuse has a price.

**It cannot see shell writes.** The guard inspects tool calls that carry a file
path — `write` and `edit`. A file written by a shell command (`Set-Content`,
`echo >`, a build script, `Copy-Item`) is invisible to it. Under a permissive
sandbox this is a complete bypass. Treat the plugin as a habit-forming
guardrail, not as containment.

**It cannot see renames.** Renaming a folder with a shell command is not
intercepted, so an agent could in principle move a `C-` folder to `CW-`. The
reservation of `CW-`/`W-` for the human is enforced on creation, not on rename.
See [Renaming into CW-/W-](#renaming-into-cw--w--is-a-prompt-convention-not-a-block)
for what the plugin does instead and how much to trust it.

**History protection is a shape check.** For a library `README.md` rewrite, the
plugin refuses if a heading is missing or an existing line would vanish. It does
not detect an entry that was reworded rather than deleted, and a shell write
skips the check entirely.

**It is opinionated about names.** `C-`, `CW-`, `T-`, `W-` and four fixed
library names are the whole scheme. If that naming does not suit you, this is
the wrong plugin — the `libraries` field can rename the libraries, but the
project prefixes are fixed.

**One machine's habits.** The rules were tuned against a real workspace with
real projects, which makes them concrete and also somewhat specific. Expect to
adjust them.

## Relation to other plugins

- **[dot-ai](https://github.com/jogelin/dot-ai)** defines a `.ai/` workspace
  convention with memory, tasks, skills, routing and a multi-platform adapter
  layer. It is a framework. This plugin is much smaller and answers one
  question: where does this file go. It has no memory, task, or routing system.
- **[cc-safety-net](https://github.com/kenryu42/cc-safety-net)** blocks
  destructive commands and sensitive-file access before a tool call runs. This
  plugin does not block dangerous commands; it enforces where output is placed.

If you want a workspace framework, use dot-ai. If you want an agent to stop
scattering files, this is a smaller tool for that.

## Uninstall

Disable or remove the bundle. The prompt section and the guard disappear
immediately. Folders the plugin encouraged remain on disk — it never deletes
anything, and it has no opinion about files that already exist.

## License

MIT. See [LICENSE](LICENSE).
