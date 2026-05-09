import { isAbsolute, join } from "node:path"

export function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}
