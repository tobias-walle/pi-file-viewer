export interface CommandFlagSpec<Flag extends string> {
  name: Flag
  tokens: readonly string[]
}

export interface ParsedCommandArgs<Flag extends string> {
  flags: ReadonlySet<Flag>
  flagOrder: readonly Flag[]
  positionals: readonly string[]
}

export function parseCommandArgs<Flag extends string>(
  args: string,
  flagSpecs: readonly CommandFlagSpec<Flag>[],
): ParsedCommandArgs<Flag> {
  const flagByToken = buildFlagLookup(flagSpecs)
  const flags = new Set<Flag>()
  const flagOrder: Flag[] = []
  const positionals: string[] = []
  let parsingFlags = true

  for (const token of splitCommandArgs(args)) {
    if (parsingFlags && token === "--") {
      parsingFlags = false
      continue
    }

    const flag = parsingFlags ? flagByToken.get(token) : undefined
    if (flag) {
      flags.add(flag)
      flagOrder.push(flag)
    } else {
      positionals.push(token)
    }
  }

  return { flags, flagOrder, positionals }
}

function buildFlagLookup<Flag extends string>(
  flagSpecs: readonly CommandFlagSpec<Flag>[],
): Map<string, Flag> {
  const flagByToken = new Map<string, Flag>()
  for (const spec of flagSpecs) {
    for (const token of spec.tokens) {
      flagByToken.set(token, spec.name)
    }
  }
  return flagByToken
}

function splitCommandArgs(args: string): string[] {
  return args.trim() ? args.trim().split(/\s+/) : []
}
