import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(120)),
  ).annotate({ description: "Optional timeout in seconds (min 1, max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const blocked = blockedUrlReason(new URL(params.url))
          if (blocked) {
            throw new Error(`URL is blocked by webfetch SSRF protection (${blocked})`)
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
          const response = yield* httpOk.execute(request).pipe(
            Effect.catchIf(
              (err) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpOk.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" }),
                  ),
                ),
            ),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                return { output: extractTextFromHTML(content), title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

// --- SSRF protection -----------------------------------------------------
// webfetch is a network-facing tool, so refuse high-risk targets before any
// request is made. Link-local and cloud metadata addresses are always blocked:
// there is no legitimate coding-agent use case for fetching them, and they are
// the primary SSRF pivots (169.254.169.254, 100.100.100.200, 169.254.0.0/16,
// fe80::/10, ::1, plus IPv4-mapped IPv6 forms).
//
// Private ranges (loopback 127.0.0.0/8, RFC1918, IPv6 ULA) are also blocked by
// default to keep the tool from reaching internal networks. This is
// deliberately stricter than relying on the permission ask alone:
// private-address fetches would otherwise be one approval away from internal
// services. Local development against hostnames like `localhost` is
// unaffected — only raw private-address literals are refused.

function blockedUrlReason(url: URL): string | undefined {
  const host = normalizeHostname(url.hostname)
  const ipv4 = host.includes(":") ? ipv4FromMapped(host) : host
  if (ipv4 && isIpv4Literal(ipv4)) {
    if (isLinkLocalOrMetadataIpv4(ipv4)) return "link-local or cloud metadata address"
    if (isPrivateIpv4(ipv4)) return "private network address"
    return undefined
  }
  if (host.includes(":")) {
    if (host === "::1" || isLinkLocalIpv6(host)) return "loopback or link-local address"
    if (isUlaIpv6(host)) return "private network address"
  }
  return undefined
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "")
}

function isIpv4Literal(value: string | undefined) {
  if (!value) return false
  const parts = value.split(".")
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))
}

function isLinkLocalOrMetadataIpv4(ipv4: string) {
  const [a, b] = ipv4.split(".").map(Number)
  // 169.254.0.0/16 link-local, which covers cloud metadata 169.254.169.254
  if (a === 169 && b === 254) return true
  // Alibaba Cloud metadata endpoint
  return ipv4 === "100.100.100.200"
}

function isPrivateIpv4(ipv4: string) {
  const [a, b] = ipv4.split(".").map(Number)
  // 127.0.0.0/8 loopback and 10.0.0.0/8
  if (a === 127 || a === 10) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  return a === 192 && b === 168
}

function isLinkLocalIpv6(host: string) {
  // fe80::/10
  return /^fe[89ab]/.test(host)
}

function isUlaIpv6(host: string) {
  // fc00::/7, which also covers the AWS IPv6 metadata endpoint fd00:ec2::254
  return /^f[cd]/.test(host)
}

// Parse an IPv4-mapped IPv6 literal like `::ffff:7f00:1` back to its IPv4 form.
function ipv4FromMapped(host: string) {
  const mapped = /^::ffff:(.+)$/.exec(host)
  if (!mapped) return undefined
  const tail = mapped[1]
  if (tail === undefined) return undefined
  if (isIpv4Literal(tail)) return tail
  const [hi, lo] = tail.split(":")
  if (hi === undefined || lo === undefined) return undefined
  const a = parseInt(hi, 16)
  const b = parseInt(lo, 16)
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`
}
