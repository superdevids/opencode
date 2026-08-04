import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 filesystem HttpApi", () => {
  test("reads a file relative to the requested location", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "hello.txt"), "hello\n")

    const response = await request("/api/fs/read/hello.txt", tmp.path)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello\n")
  })

  test("rejects list path escapes with a 403 forbidden response", async () => {
    await using tmp = await tmpdir({ git: true })

    const response = await request("/api/fs/list?path=..%2Foutside", tmp.path)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ _tag: "PathEscapeError" })
  })

  test("rejects reads that escape through a symlink with a 403 forbidden response", async () => {
    await using tmp = await tmpdir({ git: true })
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-fs-escape-"))
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "secret")
      await fs.symlink(outside, path.join(tmp.path, "link"), process.platform === "win32" ? "junction" : "dir")

      const response = await request("/api/fs/read/link/secret.txt", tmp.path)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ _tag: "PathEscapeError" })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
