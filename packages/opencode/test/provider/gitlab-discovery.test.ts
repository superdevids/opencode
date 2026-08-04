import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"

const providerID = ProviderV2.ID.make("gitlab")

function model(id: string, name: string): Provider.Model {
  return {
    id: ModelV2.ID.make(id),
    providerID,
    api: { id, url: "https://gitlab.com", npm: "gitlab-ai-provider" },
    name,
    family: "",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, input: 0, output: 64000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: {},
  }
}

function providerInfo(): Provider.Info {
  return {
    id: providerID,
    name: "gitlab",
    source: "custom",
    env: [],
    options: {},
    models: {},
  }
}

describe("provider.mergeDiscoveredModels", () => {
  test("propagates a failed discovery as a typed InitError instead of swallowing it", async () => {
    const providers: Record<ProviderV2.ID, Provider.Info> = { [providerID]: providerInfo() }
    const discover = () => Promise.reject(new Error("gitlab unreachable"))

    const error = await Effect.runPromise(
      Provider.mergeDiscoveredModels(providers, providerID, discover).pipe(Effect.flip),
    )

    expect(Provider.InitError.isInstance(error)).toBe(true)
    expect(error.message).toContain("gitlab")
    expect(Object.keys(providers[providerID].models)).toHaveLength(0)
  })

  test("merges discovered models into the provider", async () => {
    const providers: Record<ProviderV2.ID, Provider.Info> = { [providerID]: providerInfo() }
    const discover = () =>
      Promise.resolve({
        "duo-chat-sonnet-4-5": model("duo-chat-sonnet-4-5", "Duo Chat Sonnet"),
        "duo-workflow-sonnet-4-6": model("duo-workflow-sonnet-4-6", "Duo Workflow Sonnet"),
      })

    const exit = await Effect.runPromiseExit(
      Provider.mergeDiscoveredModels(providers, providerID, discover).pipe(Effect.asVoid),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(providers[providerID].models["duo-chat-sonnet-4-5"]).toBeDefined()
    expect(providers[providerID].models["duo-chat-sonnet-4-5"].name).toBe("Duo Chat Sonnet")
    expect(providers[providerID].models["duo-workflow-sonnet-4-6"]).toBeDefined()
  })

  test("does not overwrite models that already exist", async () => {
    const providers: Record<ProviderV2.ID, Provider.Info> = { [providerID]: providerInfo() }
    providers[providerID].models["duo-chat-sonnet-4-5"] = model("duo-chat-sonnet-4-5", "Original")
    const discover = () =>
      Promise.resolve({
        "duo-chat-sonnet-4-5": model("duo-chat-sonnet-4-5", "Discovered"),
      })

    await Effect.runPromise(Provider.mergeDiscoveredModels(providers, providerID, discover))

    expect(providers[providerID].models["duo-chat-sonnet-4-5"].name).toBe("Original")
  })

  test("succeeds when discovery returns no models", async () => {
    const providers: Record<ProviderV2.ID, Provider.Info> = { [providerID]: providerInfo() }
    const discover = () => Promise.resolve({})

    const exit = await Effect.runPromiseExit(Provider.mergeDiscoveredModels(providers, providerID, discover))

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(Object.keys(providers[providerID].models)).toHaveLength(0)
  })
})
