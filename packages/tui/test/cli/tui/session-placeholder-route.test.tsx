import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

test("placeholder session ids are never forwarded to the server when --continue resolves to no session", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const allRequests: string[] = []
  const calls = createFetch((url) => {
    allRequests.push(url.pathname)
    // No sessions exist, so --continue never resolves to a real session and the
    // route keeps the temporary "dummy" placeholder.
    if (url.pathname === "/session") return json([])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    await setup.renderOnce()

    // The placeholder route ("dummy" while --continue resolves, or an
    // unresolved "{id}") must never produce a session fetch request. If it
    // did, the SDK would request "/session/{placeholder}" and the server would
    // reject it with a SessionID schema error, leaving a stale error frame.
    // "/session/status" is a legitimate status poll, not a session fetch.
    const placeholderFetches = allRequests.filter(
      (pathname) => /^\/session\/[^/]+/.test(pathname) && pathname !== "/session/status",
    )
    expect(placeholderFetches).toEqual([])
    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
