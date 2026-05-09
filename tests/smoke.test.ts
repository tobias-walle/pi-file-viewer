import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

interface PackageJson {
  pi?: {
    extensions?: string[]
  }
}

const root = resolve(import.meta.dir, "..")

async function readPackageJson(): Promise<PackageJson> {
  const packageJsonPath = resolve(root, "package.json")
  return JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson
}

test("package manifest points at the extension entrypoint", async () => {
  const packageJson = await readPackageJson()
  expect(packageJson.pi?.extensions).toContain("./extension/index.ts")
})

test("extension entrypoints exist and export a default factory", async () => {
  const packageJson = await readPackageJson()
  const extensions = packageJson.pi?.extensions ?? []

  expect(extensions.length).toBeGreaterThan(0)

  for (const extensionPath of extensions) {
    const absolutePath = resolve(root, extensionPath)
    expect(existsSync(absolutePath)).toBe(true)

    const module = (await import(absolutePath)) as { default?: unknown }
    expect(typeof module.default).toBe("function")
  }
})
