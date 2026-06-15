import { execFile } from "node:child_process"

export async function copyTextToClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await pipeToCommand("pbcopy", [], text)
    return
  }

  if (process.platform === "win32") {
    await pipeToCommand("clip", [], text)
    return
  }

  const commands: Array<[string, string[]]> = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ]
  let lastError: unknown
  for (const [command, args] of commands) {
    try {
      await pipeToCommand(command, args, text)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No clipboard command available")
}

function pipeToCommand(
  command: string,
  args: string[],
  input: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, (error) => {
      if (error) reject(error)
      else resolve()
    })

    child.stdin?.end(input)
  })
}
