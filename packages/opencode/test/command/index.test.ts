import { describe, expect, test } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { testEffect } from "../lib/effect"

// The command registry is exercised with mocked Config / MCP / Skill services
// so the registry logic is tested without touching the real config file, MCP
// servers, or on-disk skills.
const commandTestLayer = (options: {
  command?: Record<string, ConfigCommandV1.Info>
  prompts?: Record<string, { name: string; description?: string; arguments?: Array<{ name: string }> } & { client: string }>
  skills?: Skill.Info[]
}) =>
  LayerNode.compile(Command.node, [
    [
      Config.node,
      Layer.mock(Config.Service)({
        get: () => Effect.succeed(options.command ? { command: options.command } : ({} as ConfigV1.Info)),
      }),
    ],
    [
      MCP.node,
      Layer.mock(MCP.Service)({
        prompts: () => Effect.succeed(options.prompts ?? {}),
        getPrompt: () =>
          Effect.succeed({
            messages: [{ role: "user", content: { type: "text", text: "resolved prompt" } }],
          }),
      }),
    ],
    [
      Skill.node,
      Layer.mock(Skill.Service)({
        all: () => Effect.succeed(options.skills ?? []),
      }),
    ],
  ])

const commandIt = (options: Parameters<typeof commandTestLayer>[0]) => testEffect(commandTestLayer(options))

describe("command.hints", () => {
  test("returns no hints for a template without placeholders", () => {
    expect(Command.hints("just a plain prompt")).toEqual([])
  })

  test("extracts numbered placeholders", () => {
    expect(Command.hints("use $1 and $2")).toEqual(["$1", "$2"])
  })

  test("sorts numbered placeholders ascending", () => {
    expect(Command.hints("$3 then $1")).toEqual(["$1", "$3"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("$1 and $1 again")).toEqual(["$1"])
  })

  test("sorts multi-digit placeholders lexicographically", () => {
    expect(Command.hints("$2 $10")).toEqual(["$10", "$2"])
  })

  test("includes $ARGUMENTS when present", () => {
    expect(Command.hints("honor $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("combines numbered placeholders with $ARGUMENTS", () => {
    expect(Command.hints("$1 with $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })
})

describe("command.Default", () => {
  test("exposes the built-in command names", () => {
    expect(Command.Default.INIT).toBe("init")
    expect(Command.Default.REVIEW).toBe("review")
  })
})

describe("command.Info", () => {
  test("decodes a minimal command", () => {
    const info = Schema.decodeUnknownSync(Command.Info)({ name: "foo", template: "hello", hints: [] })
    expect(info.name).toBe("foo")
    expect(info.template).toBe("hello")
    expect(info.hints).toEqual([])
  })

  test("decodes a fully-populated command", () => {
    const info = Schema.decodeUnknownSync(Command.Info)({
      name: "foo",
      description: "does foo",
      agent: "build",
      model: "anthropic/claude-sonnet-4",
      source: "command",
      template: "run",
      subtask: true,
      hints: ["$1"],
    })
    expect(info).toMatchObject({
      name: "foo",
      description: "does foo",
      agent: "build",
      model: "anthropic/claude-sonnet-4",
      source: "command",
      subtask: true,
      hints: ["$1"],
    })
  })

  test("rejects a command without a name", () => {
    expect(() =>
      Schema.decodeUnknownSync(Command.Info)({ template: "hello", hints: [] }),
    ).toThrow()
  })

  test("rejects an unknown source", () => {
    expect(() =>
      Schema.decodeUnknownSync(Command.Info)({ name: "foo", template: "hello", hints: [], source: "plugin" }),
    ).toThrow()
  })

  test("accepts any template value", () => {
    const info = Schema.decodeUnknownSync(Command.Info)({ name: "foo", template: 42, hints: [] })
    expect(info.template).toBe(42)
  })
})

describe("command.Service", () => {
  commandIt({}).instance("get returns the built-in init command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const init = yield* commands.get("init")
      expect(init).toBeDefined()
      expect(init?.name).toBe("init")
      expect(init?.description).toBe("guided AGENTS.md setup")
      expect(init?.source).toBe("command")
      expect(init?.hints).toEqual(["$ARGUMENTS"])
      expect(typeof init?.template).toBe("string")
      expect(init?.template).toContain("AGENTS.md")
      // The ${path} placeholder is replaced with the instance worktree.
      expect(init?.template).not.toContain("${path}")
    }),
  )

  commandIt({}).instance("get returns the built-in review command as a subtask", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const review = yield* commands.get("review")
      expect(review).toBeDefined()
      expect(review?.name).toBe("review")
      expect(review?.description).toContain("review changes")
      expect(review?.source).toBe("command")
      expect(review?.subtask).toBe(true)
      expect(review?.hints).toEqual(["$ARGUMENTS"])
      expect(typeof review?.template).toBe("string")
    }),
  )

  commandIt({
    command: {
      build: {
        template: "run build $1 $ARGUMENTS",
        description: "build the project",
        agent: "build",
        model: "anthropic/claude-sonnet-4",
        subtask: false,
      },
    },
  }).instance("get returns config-defined commands with their fields and hints", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const build = yield* commands.get("build")
      expect(build).toBeDefined()
      expect(build?.name).toBe("build")
      expect(build?.description).toBe("build the project")
      expect(build?.agent).toBe("build")
      expect(build?.model).toBe("anthropic/claude-sonnet-4")
      expect(build?.source).toBe("command")
      expect(build?.subtask).toBe(false)
      expect(build?.hints).toEqual(["$1", "$ARGUMENTS"])
      expect(build?.template).toBe("run build $1 $ARGUMENTS")
    }),
  )

  commandIt({
    skills: [
      {
        name: "myskill",
        description: "a test skill",
        location: path.join("skills", "myskill", "SKILL.md"),
        content: "skill body",
      },
    ],
  }).instance("get returns skill commands with a base directory note in the template", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const skill = yield* commands.get("myskill")
      expect(skill).toBeDefined()
      expect(skill?.name).toBe("myskill")
      expect(skill?.description).toBe("a test skill")
      expect(skill?.source).toBe("skill")
      expect(skill?.hints).toEqual([])
      expect(skill?.template).toContain("skill body")
      expect(skill?.template).toContain("Base directory for this skill:")
    }),
  )

  commandIt({
    prompts: {
      mcpprompt: {
        name: "mcpprompt",
        description: "an mcp prompt",
        arguments: [{ name: "arg1" }, { name: "arg2" }],
        client: "mcpclient",
      },
    },
  }).instance("get returns MCP prompt commands with argument hints and a resolved template", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const prompt = yield* commands.get("mcpprompt")
      expect(prompt).toBeDefined()
      expect(prompt?.name).toBe("mcpprompt")
      expect(prompt?.description).toBe("an mcp prompt")
      expect(prompt?.source).toBe("mcp")
      expect(prompt?.hints).toEqual(["$1", "$2"])
      if (prompt) {
        const template = yield* Effect.promise(() => Promise.resolve(prompt.template))
        expect(template).toBe("resolved prompt")
      }
    }),
  )

  commandIt({}).instance("get returns undefined for an unknown command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("does-not-exist")).toBeUndefined()
    }),
  )

  commandIt({}).instance("get is case-sensitive", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("Init")).toBeUndefined()
      expect(yield* commands.get("REVIEW")).toBeUndefined()
      expect(yield* commands.get("init")).toBeDefined()
    }),
  )

  commandIt({
    command: {
      build: { template: "run build", description: "build the project" },
    },
    skills: [
      {
        name: "myskill",
        description: "a test skill",
        location: path.join("skills", "myskill", "SKILL.md"),
        content: "skill body",
      },
    ],
    prompts: {
      mcpprompt: { name: "mcpprompt", description: "an mcp prompt", client: "mcpclient" },
    },
  }).instance("list returns built-in, config, skill, and mcp commands", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const names = (yield* commands.list()).map((command) => command.name).sort()
      expect(names).toEqual(["build", "init", "mcpprompt", "myskill", "review"])
    }),
  )

  commandIt({
    skills: [
      {
        name: "init",
        description: "skill shadows the built-in",
        location: path.join("skills", "init", "SKILL.md"),
        content: "shadow",
      },
    ],
  }).instance("skills cannot shadow existing commands", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const init = yield* commands.get("init")
      expect(init?.source).toBe("command")
      expect(init?.description).toBe("guided AGENTS.md setup")
    }),
  )
})
