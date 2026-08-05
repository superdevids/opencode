import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("AISDK streaming timeouts", () => {
  it.effect("defaults to a per-chunk SSE timeout when the model does not configure one", () =>
    Effect.sync(() => {
      expect(AISDK.chunkTimeoutMs(undefined)).toBe(AISDK.DEFAULT_CHUNK_TIMEOUT)
    }),
  )

  it.effect("respects an explicit chunk timeout", () =>
    Effect.sync(() => {
      expect(AISDK.chunkTimeoutMs(15_000)).toBe(15_000)
    }),
  )

  it.effect("keeps chunkTimeout false and non-positive values as an opt-out", () =>
    Effect.sync(() => {
      expect(AISDK.chunkTimeoutMs(false)).toBe(0)
      expect(AISDK.chunkTimeoutMs(0)).toBe(0)
      expect(AISDK.chunkTimeoutMs(-1)).toBe(0)
    }),
  )

  it.live("surfaces a silent SSE drop as an error instead of hanging", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => stalledSSEServer()),
        (server) => Effect.sync(() => server.server.close()),
      )

      const aisdk = yield* AISDK.Service
      let capturedFetch: ((input: any, init?: RequestInit) => Promise<Response>) | undefined
      yield* aisdk.hook.sdk((event) => {
        capturedFetch = event.options.fetch
        event.sdk = {
          languageModel: (id: string) => ({
            id,
            doStream: async () => {
              throw new Error("unused")
            },
          }),
        }
      })

      yield* aisdk.language(
        ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: {
            id: ModelV2.ID.make("model"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: server.url,
            settings: { chunkTimeout: 50 },
          },
        }),
      )
      expect(capturedFetch).toBeDefined()

      const res = yield* Effect.promise(() => capturedFetch!(server.url, { method: "POST", body: JSON.stringify({}) }))
      const error = yield* Effect.promise(async () => {
        const reader = res.body!.getReader()
        try {
          await reader.read()
          await reader.read()
          return undefined
        } catch (error) {
          return error
        }
      })
      expect(error).toBeDefined()
      expect(error instanceof Error ? error.message : String(error)).toContain("SSE read timed out")
    }),
  )
})

function stalledSSEServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n')
    // Never end the response: simulates a silent TCP drop without FIN/RST.
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}
