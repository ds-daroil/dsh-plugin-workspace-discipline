/**
 * Workspace discipline plugin.
 *
 * Enforces one project-folder convention across the whole workspace:
 *   <root>/C-<name>/   completed project   -> project body + README, no TEMP
 *   <root>/CW-<name>/  completed, disposable -> same shape, whole folder may be deleted
 *   <root>/T-<name>/   unfinished project  -> project body + README + TEMP
 *   <root>/W-<name>/   abandoned project   -> safe to delete outright
 *   <root>/tools/<tool>/  cross-project reusable tool + README
 *
 * Three contributions:
 *   1. an always-on prompt section describing the layout,
 *   2. a pre-execute guard that refuses file writes outside the layout,
 *   3. a `workspace_layout` tool that reports existing folders and tools.
 */

import path from 'node:path'
import os from 'node:os'

export const name = 'workspace-discipline'

/**
 * `workingDirectory` is optional: when the host composition provides it, the
 * plugin resolves the session's real working directory instead of guessing.
 * Older compositions without it still work through the cwd fallback.
 *
 * This runtime accepts the array form only; the optional service is looked up
 * with `ctx.get(...)` at use time, which already tolerates absence.
 */
export const inject = ['systemPrompt', 'tools']

const KINDS = {
  C: 'completed',
  CW: 'completed-disposable',
  T: 'unfinished',
  W: 'abandoned',
}

/** Files a model may legitimately write directly at the workspace root. */
const ROOT_FILE_ALLOWLIST = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  '.gitignore',
])

const FOLDER_RE = /^(CW|C|T|W)-(.+)$/

/**
 * Shared libraries that sit beside the project folders, one folder per entry:
 * a tool, a skill, an MCP server definition, or a project's written-up history.
 * Each carries its own README. Overridable through config.libraries.
 */
const DEFAULT_LIBRARIES = ['tools', 'skills', 'mcp', 'log']

/** Normalise a path for comparison: absolute, forward slashes, no trailing slash. */
function normalise(p) {
  let out = path.resolve(p).replace(/\\/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + '/')
}

/**
 * Check one absolute path against the layout.
 * Returns null when allowed, otherwise a human-readable refusal reason.
 * `ignored` holds absolute or root-relative prefixes that are exempt.
 * `libraries` is the set of shared-library folder names for this deployment.
 */
function classify(targetPath, roots, ignored = [], libraries = DEFAULT_LIBRARIES) {
  const target = normalise(targetPath)
  const root = roots.find((r) => isInside(target, r))
  if (!root) return null // outside every managed root: not our business

  const rel = target.slice(root.length).replace(/^\//, '')
  if (rel === '') return null // writing the root itself is a no-op

  // Exempt prefixes: legacy trees that predate the convention.
  for (const prefix of ignored) {
    if (rel === prefix || rel.startsWith(prefix + '/')) return null
  }

  const segments = rel.split('/')
  const first = segments[0]

  // Shared libraries. Each entry needs its own folder, so a loose file
  // directly under the library root is misplaced. The one exception is the
  // library's own README, which explains what the library is for — that
  // belongs at the root rather than being repeated in every entry.
  if (libraries.includes(first)) {
    if (segments.length === 2 && /^readme\.md$/i.test(segments[1])) return null
    if (segments.length < 3) {
      return (
        `Write into a specific entry folder: ${first}/<name>/file. ` +
        `Every entry lives in its own folder under ${first}/; only ${first}/README.md sits at the root.`
      )
    }
    return null
  }

  const match = FOLDER_RE.exec(first)
  if (match) {
    const kind = match[1]
    const folderName = first
    // Completed projects (C- and CW-) must not contain a TEMP directory.
    if ((kind === 'C' || kind === 'CW') && segments.some((s) => s.toUpperCase() === 'TEMP')) {
      return (
        `${folderName} is a completed (${kind}-) project and must not contain a TEMP folder. ` +
        'Keep reusable scripts in tools/, or delete what is no longer needed.'
      )
    }
    return null
  }

  // Root-level files that are legitimate workspace metadata.
  if (segments.length === 1 && ROOT_FILE_ALLOWLIST.has(first)) return null

  if (segments.length === 1 && first.startsWith('.')) return null

  return (
    `"${rel}" is not inside a project folder. Every file you produce belongs in ` +
    `"<root>/C-<name>/", "<root>/CW-<name>/", "<root>/T-<name>/" or "<root>/W-<name>/" ` +
    `at the workspace root, or in "<root>/tools/<tool-name>/" for a reusable tool. ` +
    'Pick (or create) one project folder first, then write inside it.'
  )
}

/** List directories under a root: project folders and each shared library. */
async function scan(root, libraries = DEFAULT_LIBRARIES) {
  const empty = { projects: [], libraries: {} }
  for (const name of libraries) empty.libraries[name] = []
  let fsp
  try {
    fsp = await import('node:fs/promises')
  } catch {
    return empty
  }

  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return empty
  }

  const projects = []
  const found = {}
  for (const name of libraries) found[name] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (libraries.includes(entry.name)) {
      try {
        const inner = await fsp.readdir(path.join(root, entry.name), { withFileTypes: true })
        for (const item of inner) {
          if (!item.isDirectory()) continue
          found[entry.name].push({ name: item.name, path: path.join(root, entry.name, item.name) })
        }
      } catch {
        // ignore an unreadable library dir
      }
      continue
    }
    const match = FOLDER_RE.exec(entry.name)
    if (!match) continue
    projects.push({
      folder: entry.name,
      name: match[2],
      kind: match[1],
      status: KINDS[match[1]],
      path: path.join(root, entry.name),
    })
  }

  projects.sort((a, b) => a.folder.localeCompare(b.folder))
  for (const key of Object.keys(found)) {
    found[key].sort((a, b) => a.name.localeCompare(b.name))
  }
  return { projects, libraries: found }
}

function renderPrompt(roots, ignored = [], libraries = DEFAULT_LIBRARIES) {
  const list = roots.map((r) => `- ${r}`).join('\n')
  const exempt =
    ignored.length > 0
      ? ['', '## Exempt paths (legacy, do not migrate)', '', ...ignored.map((p) => `- \`${p}\``), '']
      : ['']
  const names = libraries.map((n) => `${n}/`).join(', ')
  return [
    '# Workspace layout (enforced)',
    '',
    'Every session works inside a project folder at the workspace root. Putting files outside this layout is a violation of the owner\'s convention — it is not only a guard to sneak past, it is the expected way to work.',
    '',
    'The guard below inspects `write` and `edit` calls. It cannot see a file written by a shell command, so it is a guardrail, not a security boundary: a rule obeyed only to avoid rejection, and then worked around, has failed the point.',
    '',
    ...(roots.length > 0 ? ['Workspace root(s):', list, ''] : []),
    '## Everything must live here',
    '',
    'Migrate the project into this workspace. Do not work in a temp directory, a home folder, a desktop folder, or any other location and leave the result there. If work started outside the workspace, move it in before finishing — this workspace is the one place a later session will look, and a project left anywhere else is lost work as far as this machine is concerned.',
    '',
    'A project that exists nowhere in this workspace, but should, is an unfinished migration: say so and complete it, rather than treating the outside copy as good enough.',
    '',
    '## Project folders',
    '',
    'A project folder is named `<KIND>-<project-name>`, where KIND is one of these prefixes:',
    '',
    '- `C-` — completed, worth keeping. Contains the finished project body plus a README. No `TEMP` folder.',
    '- `CW-` — completed, and disposable. The result was obtained; nothing in the folder is worth keeping. No `TEMP` folder.',
    '- `T-` — unfinished, still in progress. Contains the project body, a README, and may contain `TEMP`.',
    '- `W-` — abandoned half-done. Nothing in it is worth keeping.',
    '',
    '**You may only create `C-` or `T-` folders.** `CW-` and `W-` are assigned by the user alone: creating one is refused. When finished work is a one-off whose value is already captured elsewhere, leave it in `C-` and say so — the user decides whether it becomes disposable. Writing inside a `CW-` or `W-` folder that already exists is fine.',
    '',
    '### Once a folder becomes CW- or W-, everything in it is forfeit',
    '',
    'The user may delete a `CW-` or `W-` folder at any moment, without asking and without reading it. Treat every file in one as already gone: do not build on it, do not reference it from other projects, do not defer a decision thinking you can come back to it later, and never tell the user that something is preserved because it happens to be in there.',
    '',
    'The exceptions are reusable output and the project\'s own history. **Before** a folder can become `CW-` or `W-`:\n\n- extract each reusable tool, skill or MCP server that deserves to survive into its library folder (`tools/`, `skills/`, `mcp/`), with its README, and\n- write the project\'s experience into the log library under `<the-same-folder-name>`.\n\nAnything not extracted is condemned along with the folder. Extract and write the log first, downgrade second — in that order, never the reverse.',
    '',
    'One folder per project, not per session. Within a single session that covers several projects, give each project its own folder. Across several sessions working on the same project, reuse the one existing folder.',
    '',
    'Before starting work, look at the existing folders. If a folder for this project already exists, continue in it — do not create a second one. A new folder is for a new project, never a second attempt at an existing one.',
    '',
    '## Temporary files',
    '',
    'Delete temporary files you no longer need. Anything that must be kept for a `T-` or `W-` project goes in that project\'s `TEMP` subfolder. `C-` and `CW-` projects get no `TEMP`: finished work keeps only what it needs.',
    ...exempt,
    '## Shared libraries',
    '',
    libraries.length === 4 && libraries.includes('log')
      ? 'Four folders sit beside the projects, each holding one folder per entry. The same rules apply to all four:'
      : `These folders sit beside the projects (${names}), each holding one folder per entry. The same rules apply to all of them:`,
    '',
    ...(libraries.includes('tools')
      ? ['- `tools/<tool-name>/` — a reusable script, converter, extractor or validator.']
      : []),
    ...(libraries.includes('skills')
      ? ['- `skills/<skill-name>/` — a reusable skill body (`SKILL.md`) that teaches a repeatable procedure.']
      : []),
    ...(libraries.includes('mcp')
      ? ['- `mcp/<server-name>/` — a reusable MCP server definition or its configuration.']
      : []),
    ...(libraries.includes('log')
      ? ['- `log/<project-folder-name>/` — what a disposed project went through, written before it is thrown away.']
      : []),
    '',
    'An entry is reusable when it will serve more than one project or more than one session. Project-specific one-offs stay inside that project folder.',
    '',
    'Every entry README records: what it does, how to invoke it, which projects used it, and what it achieved. When an entry changes, append the change and the date to its existing README instead of rewriting history.',
    '',
    ...(libraries.includes('log')
      ? [
          '### The log library',
          '',
          'The log library holds one folder per disposed project, named exactly like the project folder it came from (`CW-ai-sidebar/` is recorded as `log/CW-ai-sidebar/`), so the history and the folder can always be matched up.',
          '',
          'Write the log **when a project becomes `CW-` or `W-`**, not later: the folder may be gone by the time you come back. A `C-` project needs no log entry — its own README already holds whatever is worth keeping.',
          '',
          'The log records what is worth knowing after the artifacts are gone:',
          '',
          '- what the project was for and what it actually produced,',
          '- what worked and is worth reusing as an approach,',
          '- what broke, why, and how it was fixed,',
          '- what state it ended in and what a future session should know before touching the subject again.',
          '',
          'A log is a record, not a rebuild kit: it does not have to reproduce the project, and it should not claim the project still exists.',
          '',
        ]
      : []),
    '### Search the library before you extract anything',
    '',
    'Extracting a tool means taking it out of a project, so before writing a new one **search the library first** — list the entries and read the READMEs that plausibly apply.',
    '',
    'If the library already holds a tool that is better or more complete than what you extracted, **do not add the extracted one.** Use the library tool. A second tool doing the same job less well is duplication, and duplication is worse than the thing it duplicates, because now there are two answers and no way to tell which is current.',
    '',
    'Two cases justify a new entry:',
    '',
    '- The extracted tool is better or more complete than the library one. Then **ask the user** whether to overwrite the library copy, rather than deciding yourself.',
    '- The domain demands a shape the library cannot provide — something only works this way, such as an engine or a game whose loader, file format or API admits exactly one arrangement. Record the reason in the README so the next session does not read it as duplication.',
    '',
    '### Overwriting an existing tool',
    '',
    'Only overwrite with the user\'s agreement, and **never delete the original README.** Keep the file and amend it: record that the body was replaced, with what, why, and on what date. The README is the tool\'s history; the tool body is only its current state.',
    '',
    '## Before you start a new project',
    '',
    'Read the README of each tool, skill and MCP server that plausibly applies. Reuse beats rebuilding, and something you have not read is something you will accidentally duplicate.',
  ].join('\n')
}
/** Kinds the model may not assign to a new folder; only the user may. */
const CLOSED_KINDS = new Set(['CW', 'W'])

/**
 * Refuse a write that would OPEN a new CW-/W- folder.
 *
 * The rule is about folder creation, not about writing inside one: once the
 * user has created or renamed a folder into CW-/W-, the model must still be
 * able to put files in it. So the check is "does this folder already exist?".
 * Returns null when allowed, otherwise the refusal reason.
 */
async function closedKindRefusal(filePath, roots, ctx) {
  const target = normalise(filePath)
  const root = roots.find((r) => isInside(target, r))
  if (!root) return null

  const rel = target.slice(root.length).replace(/^\//, '')
  if (!rel) return null

  const first = rel.split('/')[0]
  const match = FOLDER_RE.exec(first)
  if (!match || !CLOSED_KINDS.has(match[1])) return null

  // Allowed if the folder itself is already present before this call.
  const fs = ctx?.get?.('fs')
  if (fs) {
    try {
      const dir = await fs.resolve(path.join(root, first))
      const info = await fs.stat(dir)
      if (info) return null
    } catch {
      // Unresolvable counts as absent: fall through to the refusal.
    }
  } else {
    try {
      const fsp = await import('node:fs/promises')
      await fsp.stat(path.join(root, first))
      return null
    } catch {
      // absent
    }
  }

  return (
    `Cannot create a new "${first}" folder. The ${match[1]}- kind is reserved for the user: ` +
    'only they decide that a project is finished-and-disposable (CW-) or abandoned (W-). ' +
    'Create a C- or T- folder instead, and let the user reassign it if they want it disposable. ' +
    '(Writing inside an existing CW-/W- folder is still allowed.)'
  )
}

/**
 * Refuse rewriting a tool's README in a way that loses its change history.
 *
 * `<library>/<name>/README.md` must carry a `## Changes` section, and the owner's
 * rule is to append there rather than rewrite history. Applies to every shared
 * library (tools, skills, mcp). Two checks, both on the shape because the plugin
 * has no snapshot of prior content for an edit:
 *
 *   1. the `## Changes` heading must survive, and
 *   2. every existing `- ` entry must still appear in the replacement text.
 *
 * Check 2 is what stops "keep the heading, delete the history". It is still not a
 * guarantee: a shell write bypasses this entirely, and an entry rewritten word for
 * word is indistinguishable from a preserved one. It catches the destructive
 * rewrite, which is the one that actually loses information.
 *
 * `current` is the existing file text (null when the file is new).
 */
function changelogViolation(filePath, incoming, current, roots, libraries = DEFAULT_LIBRARIES, logName = 'log') {
  const target = normalise(filePath)
  const root = roots.find((r) => isInside(target, r))
  if (!root) return null

  const rel = target.slice(root.length).replace(/^\//, '')
  const parts = rel.split('/')
  if (!libraries.includes(parts[0])) return null
  if (!/^readme\.md$/i.test(parts[parts.length - 1])) return null
  if (typeof incoming !== 'string') return null

  // Both an entry README (`<lib>/<name>/README.md`) and the library's own
  // README (`<lib>/README.md`) are protected. The root README used to be
  // exempt because it could not exist; once it became writable it also became
  // the one README with no history protection at all.
  const isEntryReadme = parts.length >= 3
  const isLibraryReadme = parts.length === 2
  if (!isEntryReadme && !isLibraryReadme) return null

  // A log entry is a one-off record of a project that is already gone; it has
  // no history of its own to protect, so requiring `## Changes` there would be
  // ceremony. The log library's root README still carries one, because the
  // library's own catalogue does change over time.
  if (parts[0] === logName && isEntryReadme) return null

  const label = parts.length === 2 ? `${parts[0]}/README.md` : `${parts[0]}/${parts[1]}/README.md`
  if (!/^##\s+Changes\s*$/m.test(incoming)) {
    return `${label} must keep a "## Changes" section: append the change and its date instead of rewriting history.`
  }

  // Every content line the file already had must survive the rewrite.
  //
  // This used to match only `- **date**` bullets, which silently left table
  // rows and prose history unprotected: a README that indexed its entries in a
  // table could be rewritten and the table deleted without any refusal. The
  // check is now line-shaped rather than format-shaped, so it holds whatever
  // way the file happens to record things.
  const existing = (typeof current === 'string' ? current : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^#{1,6}\s/.test(line) && line !== '---')
  const lost = existing.filter((entry) => !incoming.includes(entry))
  if (lost.length > 0) {
    return (
      `${label} would lose ${lost.length} existing line${lost.length === 1 ? '' : 's'} ` +
      `(starting "${lost[0].slice(0, 60)}…"). Append to this file instead of rewriting it, ` +
      'or ask the user first if a real cut is intended.'
    )
  }

  return null
}

/** Read the current text of a workspace file, or null when it does not exist. */
async function readExisting(filePath, ctx) {
  const fs = ctx?.get?.('fs')
  if (fs) {
    try {
      const target = await fs.resolve(filePath)
      if (!(await fs.stat(target))) return null
      return await fs.readText(target)
    } catch {
      return null
    }
  }
  try {
    const fsp = await import('node:fs/promises')
    return await fsp.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Resolve the agent's own working directory.
 *
 * `process.cwd()` is a deployment-wide value and is frequently NOT the
 * workspace the user selected — a harness launched from an install directory
 * reports that directory instead. So the session's committed directory is the
 * right source, and cwd is only the last resort.
 */
async function sessionDirectory(ctx, agent) {
  const wd = ctx?.get?.('workingDirectory')
  if (wd && agent) {
    try {
      return await wd.ensure(agent)
    } catch {
      // fall through
    }
  }
  return undefined
}

export function apply(ctx, config = {}) {
  const configuredRoots = Array.isArray(config.roots) ? config.roots : []
  const strict = config.strict !== false

  const libraries =
    Array.isArray(config.libraries) && config.libraries.length > 0
      ? config.libraries.map((n) => String(n).replace(/^\/+|\/+$/g, '')).filter(Boolean)
      : DEFAULT_LIBRARIES

  const logName = libraries.includes('log') ? 'log' : libraries[libraries.length - 1]

  // Explicit roots win. Otherwise each session resolves its own directory, so
  // one installation serves any workspace without editing the config.
  const fixedRoots = configuredRoots.map((r) => normalise(r)).filter(Boolean)
  let roots = fixedRoots

  const resolveRoots = async (agent) => {
    if (fixedRoots.length > 0) return fixedRoots
    const dir = await sessionDirectory(ctx, agent)
    return [normalise(dir ?? process.cwd())]
  }

  // Exempt prefixes are authored root-relative (e.g. "legacy/rwfix") or absolute.
  const ignored = (Array.isArray(config.ignore) ? config.ignore : [])
    .map((p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .map((p) => (path.isAbsolute(p) ? normalise(p) : p))

  // 1. Always-on prompt section.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'workspace-discipline',
      order: ctx.systemPrompt.getSectionOrder?.('workspace-discipline') ?? 100,
      // The section provider is synchronous by contract, but the session
      // directory is only reachable asynchronously. Rendering cwd before the
      // session root is known would state a root that may be wrong — a harness
      // launched from an install directory reports that directory, not the
      // workspace. So the root line is omitted until a root is actually known,
      // and `agent/created` fills it in before the first request.
      text: () => {
        const known = roots.length > 0 ? roots : fixedRoots
        return renderPrompt(known, ignored, libraries)
      },
    }),
  )

  // Resolve the session root as soon as an agent exists, so the prompt is
  // correct before the first write rather than only after one.
  ctx.on('agent/created', async (payload) => {
    if (fixedRoots.length > 0) return
    const dir = await sessionDirectory(ctx, payload?.agent)
    if (dir) roots = [normalise(dir)]
  })

  // 2. Write guard.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = exec?.arguments
    if (strict && args && typeof args === 'object' && typeof args.file_path === 'string') {
      const activeRoots = await resolveRoots(exec.agent)
      roots = activeRoots
      // A model may not open a new CW-/W- folder; only the user assigns those kinds.
      const owned = await closedKindRefusal(args.file_path, activeRoots, ctx)
      if (owned) {
        return { kind: 'deny', reason: owned, info: { name: 'workspace-discipline', code: 'CLOSED_KIND' } }
      }
      const reason = classify(args.file_path, activeRoots, ignored, libraries)
      if (reason) {
        return { kind: 'deny', reason, info: { name: 'workspace-discipline', code: 'LAYOUT_VIOLATION' } }
      }
      const doc = changelogViolation(
        args.file_path,
        args.content,
        args.content === undefined ? null : await readExisting(args.file_path, ctx),
        activeRoots,
        libraries,
        logName,
      )
      if (doc) {
        return { kind: 'deny', reason: doc, info: { name: 'workspace-discipline', code: 'TOOL_CHANGELOG' } }
      }
    }
    return next()
  })

  // 3. Discovery tool.
  ctx.effect(() =>
    ctx.tools.register({
      name: 'workspace_layout',
      description:
        'List the project folders (C- completed, CW- completed-and-disposable, T- unfinished, W- abandoned) ' +
        `and the shared libraries at the workspace root: ${libraries.map((n) => `${n}/<name>`).join(', ')}. ` +
        'Call this before starting a project so you continue an existing folder instead of creating a duplicate, ' +
        'and to find entries worth reusing.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            roots: { type: 'array', items: { type: 'string' } },
            projects: { type: 'array', items: { type: 'object' } },
            ...Object.fromEntries(libraries.map((n) => [n, { type: 'array', items: { type: 'object' } }])),
          },
          required: ['roots', 'projects', ...libraries],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = []
          lines.push(`roots: ${value.roots.join(', ')}`)
          lines.push('')
          lines.push(`projects (${value.projects.length}):`)
          if (value.projects.length === 0) lines.push('  (none)')
          for (const p of value.projects) lines.push(`  ${p.folder}  [${p.status}]`)
          for (const lib of libraries) {
            const items = value[lib] ?? []
            lines.push('')
            lines.push(`${lib} (${items.length}):`)
            if (items.length === 0) lines.push('  (none)')
            for (const item of items) lines.push(`  ${lib}/${item.name}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(_args, exec) {
        const activeRoots = await resolveRoots(exec?.agent)
        roots = activeRoots
        const projects = []
        const collected = {}
        for (const name of libraries) collected[name] = []
        for (const root of activeRoots) {
          const found = await scan(root, libraries)
          projects.push(...found.projects)
          for (const name of libraries) collected[name].push(...(found.libraries[name] ?? []))
        }
        return { roots: activeRoots, projects, ...collected }
      },
    }),
  )
}
