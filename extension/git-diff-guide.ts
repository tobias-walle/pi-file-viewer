import {
  type Api,
  complete,
  type Message,
  type Model,
} from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  discoverGitRepository,
  type GitDiffViewOptions,
  loadGitChangedFiles,
  loadGitFullDiff,
} from "./git-diff.js"
import type { GitChangedFile, GitDiffGuideEntry } from "./types.js"

const GUIDE_REASON_MAX_CHARS = 140
const MAX_GUIDE_CORRECTIONS = 3
const GUIDE_MAX_OUTPUT_TOKENS = 2048
const GUIDE_CONTEXT_SAFETY_RATIO = 0.9

const SYSTEM_PROMPT = `You are planning an optimal human review order for a git diff.

Read order goal: minimize backtracking and help the reviewer understand intent, contracts, core behavior, wiring, UI, and tests in a natural sequence.

Ordering heuristics:
1. Docs, specs, config, schemas, types, public APIs, and migrations first.
2. Core domain logic, state, and data model next.
3. Integration points, callers, command wiring, and adapters after core logic.
4. UI and rendering after the state or data they present.
5. Tests, examples, fixtures, and snapshots after the code they validate.
6. Generated files, lockfiles, and pure formatting changes last.
7. Keep tightly coupled files adjacent.
8. Prefer definitions before dependents.
9. For renames/deletes, place the file near related callers or replacements.

For each guide reason, write a concise review cue.

A good cue explains:
- the file's role in the overall change
- why it belongs at this point in the reading order
- the main thing the reviewer should verify

Prefer dependency and risk language:
- Defines the parser contract used by command wiring. Check flag/ref ambiguity.
- Adds guide generation and validation. Check retry behavior and failure messages.
- Renders guide notes in the viewer. Check it does not disturb comments or line mapping.
- Covers parser combinations. Read after parser changes to confirm expected CLI behavior.

Avoid:
- restating the filename
- generic summaries like "updates tests"
- vague phrases like "contains changes"
- implementation detail lists
- claims not supported by the diff

For tests, say what production behavior they validate.
For UI, say what state or interaction risk to check.
For generated/lock files, say "skim" and why.
Keep each cue under 140 characters.

Output exactly one line per changed file:
<canonical path><TAB><review cue>

The path must match the changed file list exactly.
Use every path exactly once.
Do not include bullets, numbering, markdown, code fences, or extra text.`

export class GitDiffGuideError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitDiffGuideError"
  }
}

export interface GitDiffGuide {
  entries: GitDiffGuideEntry[]
}

type ValidationResult =
  | { ok: true; entries: GitDiffGuideEntry[] }
  | { ok: false; errors: string[] }

export async function createGitDiffGuide(
  ctx: ExtensionContext,
  options: GitDiffViewOptions,
  signal?: AbortSignal,
): Promise<GitDiffGuide> {
  const model = ctx.model
  if (!model) throw new GitDiffGuideError("No model selected")

  const discovery = await discoverGitRepository(
    ctx.sessionManager.getCwd() || ctx.cwd,
    options.compareRef,
    options.scope,
  )
  if (discovery.status !== "ok") throw new GitDiffGuideError(discovery.message)

  const files = await loadGitChangedFiles(
    discovery.root,
    discovery.base,
    options.scope,
  )
  if (files.length === 0) return { entries: [] }

  const diff = await loadGitFullDiff(
    discovery.root,
    discovery.base,
    options.scope,
    files,
  )
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  const apiKey = auth.ok ? auth.apiKey : undefined
  if (!auth.ok || !apiKey) {
    throw new GitDiffGuideError(
      auth.ok ? `No API key for ${model.provider}` : auth.error,
    )
  }
  const requestAuth = { apiKey, headers: auth.headers }

  let prompt = buildInitialPrompt(files, diff)
  let lastErrors: string[] = []
  let lastOutput = ""

  for (let attempt = 0; attempt <= MAX_GUIDE_CORRECTIONS; attempt++) {
    ensurePromptFitsModel(model.contextWindow, prompt)

    const output = await requestGuideOutput(model, prompt, requestAuth, signal)
    const validation = validateGitDiffGuideOutput(output, files)
    if (validation.ok) return { entries: validation.entries }

    lastErrors = validation.errors
    lastOutput = output
    if (attempt === MAX_GUIDE_CORRECTIONS) break
    prompt = buildCorrectionPrompt(files, diff, output, validation.errors)
  }

  throw new GitDiffGuideError(
    `Guide output invalid after ${MAX_GUIDE_CORRECTIONS} corrections:\n${formatGuideErrors(lastErrors)}\n\nLast output:\n${lastOutput.trim()}`,
  )
}

async function requestGuideOutput(
  model: Model<Api>,
  prompt: string,
  auth: { apiKey: string; headers?: Record<string, string> },
  signal?: AbortSignal,
): Promise<string> {
  const response = await complete(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [userMessage(prompt)],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: GUIDE_MAX_OUTPUT_TOKENS,
    },
  )

  if (response.stopReason === "aborted") {
    throw new GitDiffGuideError("Guide generation cancelled")
  }
  if (response.stopReason !== "stop") {
    throw new GitDiffGuideError(
      `Guide model stopped with ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`,
    )
  }

  const text = response.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n")
    .trim()

  if (!text) throw new GitDiffGuideError("Guide model returned no text")
  return text
}

function userMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }
}

function buildInitialPrompt(files: GitChangedFile[], diff: string): string {
  return `${changedFilesSection(files)}\n\n## Full diff\n\n${diff}`
}

function buildCorrectionPrompt(
  files: GitChangedFile[],
  diff: string,
  output: string,
  errors: string[],
): string {
  return `${changedFilesSection(files)}\n\n## Full diff\n\n${diff}\n\n## Previous output\n\n${output}\n\n## Validation errors\n\n${formatGuideErrors(errors)}\n\nReturn the full corrected list only. Use exactly one line per changed file in this format:\n<canonical path><TAB><review cue>`
}

function changedFilesSection(files: GitChangedFile[]): string {
  return `## Changed files\n\n${files.map(formatChangedFile).join("\n")}`
}

function formatChangedFile(file: GitChangedFile): string {
  const path =
    file.status === "R" && file.oldPath
      ? `${file.oldPath} -> ${file.path}`
      : file.path
  return `${file.status} ${path} -${file.removed} +${file.added}`
}

function ensurePromptFitsModel(contextWindow: number, prompt: string): void {
  const inputTokens = estimateTokens(`${SYSTEM_PROMPT}\n\n${prompt}`)
  const outputTokens = GUIDE_MAX_OUTPUT_TOKENS
  const availableTokens = Math.floor(
    contextWindow * GUIDE_CONTEXT_SAFETY_RATIO - outputTokens,
  )

  if (inputTokens > availableTokens) {
    throw new GitDiffGuideError(
      `Diff is too large for guide model context: estimated ${inputTokens} input tokens, available ${availableTokens}`,
    )
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function validateGitDiffGuideOutput(
  output: string,
  files: readonly GitChangedFile[],
): ValidationResult {
  const expectedPaths = new Set(files.map((file) => file.path))
  const seenPaths = new Set<string>()
  const entries: GitDiffGuideEntry[] = []
  const errors: string[] = []

  output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const parsed = parseGuideLine(line)
      if (!parsed) {
        errors.push(`Line ${index + 1} must be <path><TAB><review cue>`)
        return
      }

      if (!expectedPaths.has(parsed.path)) {
        errors.push(`Line ${index + 1} has unknown path: ${parsed.path}`)
        return
      }
      if (seenPaths.has(parsed.path)) {
        errors.push(`Line ${index + 1} duplicates path: ${parsed.path}`)
        return
      }
      seenPaths.add(parsed.path)

      const reasonLength = Array.from(parsed.reason).length
      if (reasonLength === 0) {
        errors.push(`Line ${index + 1} for ${parsed.path} has an empty cue`)
      }
      if (reasonLength > GUIDE_REASON_MAX_CHARS) {
        errors.push(
          `Line ${index + 1} for ${parsed.path} cue is ${reasonLength} chars, max is ${GUIDE_REASON_MAX_CHARS}`,
        )
      }

      entries.push({
        path: parsed.path,
        reason: parsed.reason,
        rank: entries.length + 1,
      })
    })

  for (const path of expectedPaths) {
    if (!seenPaths.has(path)) errors.push(`Missing path: ${path}`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, entries }
}

function parseGuideLine(
  line: string,
): { path: string; reason: string } | undefined {
  const separator = line.indexOf("\t")
  if (separator < 0) return undefined
  return {
    path: line.slice(0, separator).trim(),
    reason: line.slice(separator + 1).trim(),
  }
}

function formatGuideErrors(errors: readonly string[]): string {
  const shown = errors.slice(0, 8).join("\n")
  if (errors.length <= 8) return shown
  return `${shown}\n...and ${errors.length - 8} more`
}
