import {
  Cookies,
  type Etag,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpMultiplex,
  HttpPlatform,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
  UrlParams
} from "@effect/platform"
import { NodeContext, NodeEtag, NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import * as Schema from "@effect/schema/Schema"
import { Deferred, Duration, Fiber, pipe, Stream } from "effect"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { createServer } from "http"
import * as Buffer from "node:buffer"
import { assert, describe, expect, it } from "vitest"

const ServerLive = NodeHttpServer.layer(createServer, { port: 0 })
const EnvLive = Layer.mergeAll(
  NodeContext.layer,
  NodeEtag.layer,
  ServerLive,
  NodeHttpClient.layerWithoutAgent
).pipe(
  Layer.provide(NodeHttpClient.makeAgentLayer({ keepAlive: false }))
)
const runPromise = <E, A>(
  effect: Effect.Effect<
    A,
    E,
    | NodeContext.NodeContext
    | Etag.Generator
    | HttpServer.HttpServer
    | HttpPlatform.HttpPlatform
    | HttpClient.HttpClient.Default
  >
) => Effect.runPromise(Effect.provide(effect, EnvLive))

const Todo = Schema.Struct({
  id: Schema.Number,
  title: Schema.String
})
const IdParams = Schema.Struct({
  id: Schema.NumberFromString
})
const todoResponse = HttpServerResponse.schemaJson(Todo)

const makeClient = Effect.map(
  Effect.all([HttpServer.HttpServer, HttpClient.HttpClient]),
  ([server, client]) =>
    HttpClient.mapRequest(
      client,
      HttpClientRequest.prependUrl(`http://127.0.0.1:${(server.address as HttpServer.TcpAddress).port}`)
    )
)
const makeTodoClient = Effect.map(
  makeClient,
  HttpClient.mapEffectScoped(
    HttpClientResponse.schemaBodyJson(Todo)
  )
)

describe("HttpServer", () => {
  it("schema", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.get(
          "/todos/:id",
          Effect.flatMap(
            HttpRouter.schemaParams(IdParams),
            ({ id }) => todoResponse({ id, title: "test" })
          )
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeTodoClient
      const todo = yield* client(HttpClientRequest.get("/todos/1"))
      expect(todo).toEqual({ id: 1, title: "test" })
    }).pipe(Effect.scoped, runPromise))

  it("formData", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const request = yield* HttpServerRequest.HttpServerRequest
            const formData = yield* request.multipart
            const part = formData.file
            assert(typeof part !== "string")
            const file = part[0]
            expect(file.path.endsWith("/test.txt")).toEqual(true)
            expect(file.contentType).toEqual("text/plain")
            return yield* HttpServerResponse.json({ ok: "file" in formData })
          })
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const formData = new FormData()
      formData.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt")
      const result = yield* client(HttpClientRequest.post("/upload", { body: HttpBody.formData(formData) })).pipe(
        HttpClientResponse.json
      )

      expect(result).toEqual({ ok: true })
    }).pipe(Effect.scoped, runPromise))

  it("schemaBodyForm", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const files = yield* HttpServerRequest.schemaBodyForm(Schema.Struct({
              file: Multipart.FilesSchema,
              test: Schema.String
            }))
            expect(files).toHaveProperty("file")
            expect(files).toHaveProperty("test")
            return HttpServerResponse.empty()
          })
        ),
        Effect.tapErrorCause(Effect.logError),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const formData = new FormData()
      formData.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt")
      formData.append("test", "test")
      const response = yield* pipe(
        client(HttpClientRequest.post("/upload", { body: HttpBody.formData(formData) })),
        Effect.scoped
      )
      expect(response.status).toEqual(204)
    }).pipe(Effect.scoped, runPromise))

  it("formData withMaxFileSize", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const request = yield* HttpServerRequest.HttpServerRequest
            yield* request.multipart
            return HttpServerResponse.empty()
          })
        ),
        Effect.catchTag("MultipartError", (error) =>
          error.reason === "FileTooLarge" ?
            HttpServerResponse.empty({ status: 413 }) :
            Effect.fail(error)),
        HttpServer.serveEffect(),
        Multipart.withMaxFileSize(Option.some(100))
      )
      const client = yield* makeClient
      const formData = new FormData()
      const data = new Uint8Array(1000)
      formData.append("file", new Blob([data], { type: "text/plain" }), "test.txt")
      const response = yield* pipe(
        client(HttpClientRequest.post("/upload", { body: HttpBody.formData(formData) })),
        Effect.scoped
      )
      expect(response.status).toEqual(413)
    }).pipe(Effect.scoped, runPromise))

  it("formData withMaxFieldSize", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const request = yield* HttpServerRequest.HttpServerRequest
            yield* request.multipart
            return HttpServerResponse.empty()
          })
        ),
        Effect.catchTag("MultipartError", (error) =>
          error.reason === "FieldTooLarge" ?
            HttpServerResponse.empty({ status: 413 }) :
            Effect.fail(error)),
        HttpServer.serveEffect(),
        Multipart.withMaxFieldSize(100)
      )
      const client = yield* makeClient
      const formData = new FormData()
      const data = new Uint8Array(1000).fill(1)
      formData.append("file", new TextDecoder().decode(data))
      const response = yield* pipe(
        client(HttpClientRequest.post("/upload", { body: HttpBody.formData(formData) })),
        Effect.scoped
      )
      expect(response.status).toEqual(413)
    }).pipe(Effect.scoped, Effect.tapErrorCause(Effect.log), runPromise))

  it("mount", () =>
    Effect.gen(function*(_) {
      const child = HttpRouter.empty.pipe(
        HttpRouter.get("/", Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url))),
        HttpRouter.get("/:id", Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url)))
      )
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.mount("/child", child),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const todo = yield* pipe(client(HttpClientRequest.get("/child/1")), Effect.flatMap((_) => _.text), Effect.scoped)
      expect(todo).toEqual("/1")
      const root = yield* pipe(client(HttpClientRequest.get("/child")), Effect.flatMap((_) => _.text), Effect.scoped)
      expect(root).toEqual("/")
    }).pipe(Effect.scoped, runPromise))

  it("mountApp", () =>
    Effect.gen(function*(_) {
      const child = HttpRouter.empty.pipe(
        HttpRouter.get("/", Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url))),
        HttpRouter.get("/:id", Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url)))
      )
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.mountApp("/child", child),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const todo = yield* pipe(client(HttpClientRequest.get("/child/1")), HttpClientResponse.text)
      expect(todo).toEqual("/1")
      const root = yield* pipe(client(HttpClientRequest.get("/child")), HttpClientResponse.text)
      expect(root).toEqual("/")
    }).pipe(Effect.scoped, runPromise))

  it("mountApp/includePrefix", () =>
    Effect.gen(function*(_) {
      const child = HttpRouter.empty.pipe(
        HttpRouter.get(
          "/child/",
          Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url))
        ),
        HttpRouter.get(
          "/child/:id",
          Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url))
        )
      )
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.mountApp("/child", child, { includePrefix: true }),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const todo = yield* pipe(client(HttpClientRequest.get("/child/1")), HttpClientResponse.text)
      expect(todo).toEqual("/child/1")
      const root = yield* pipe(client(HttpClientRequest.get("/child")), HttpClientResponse.text)
      expect(root).toEqual("/child")
    }).pipe(Effect.scoped, runPromise))

  it("file", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        yield* pipe(
          HttpServerResponse.file(`${__dirname}/fixtures/text.txt`),
          Effect.updateService(
            HttpPlatform.HttpPlatform,
            (_) => ({
              ..._,
              fileResponse: (path, options) =>
                Effect.map(
                  _.fileResponse(path, options),
                  (res) => {
                    ;(res as any).headers.etag = "\"etag\""
                    return res
                  }
                )
            })
          )
        ),
        Effect.tapErrorCause(Effect.logError),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const res = yield* pipe(client(HttpClientRequest.get("/")), Effect.scoped)
      expect(res.status).toEqual(200)
      expect(res.headers["content-type"]).toEqual("text/plain")
      expect(res.headers["content-length"]).toEqual("27")
      expect(res.headers.etag).toEqual("\"etag\"")
      const text = yield* pipe(res.text)
      expect(text.trim()).toEqual("lorem ipsum dolar sit amet")
    }).pipe(Effect.scoped, runPromise))

  it("fileWeb", () =>
    Effect.gen(function*(_) {
      const now = new Date()
      const file = new Buffer.File([new TextEncoder().encode("test")], "test.txt", {
        type: "text/plain",
        lastModified: now.getTime()
      })
      yield* pipe(
        HttpServerResponse.fileWeb(file),
        Effect.updateService(
          HttpPlatform.HttpPlatform,
          (_) => ({
            ..._,
            fileWebResponse: (path, options) =>
              Effect.map(
                _.fileWebResponse(path, options),
                (res) => ({ ...res, headers: { ...res.headers, etag: "W/\"etag\"" } })
              )
          })
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const res = yield* pipe(client(HttpClientRequest.get("/")), Effect.scoped)
      expect(res.status).toEqual(200)
      expect(res.headers["content-type"]).toEqual("text/plain")
      expect(res.headers["content-length"]).toEqual("4")
      expect(res.headers["last-modified"]).toEqual(now.toUTCString())
      expect(res.headers.etag).toEqual("W/\"etag\"")
      const text = yield* res.text
      expect(text.trim()).toEqual("test")
    }).pipe(Effect.scoped, runPromise))

  it("schemaBodyUrlParams", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/todos",
          Effect.flatMap(
            HttpServerRequest.schemaBodyUrlParams(Schema.Struct({
              id: Schema.NumberFromString,
              title: Schema.String
            })),
            ({ id, title }) => todoResponse({ id, title })
          )
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeTodoClient
      const todo = yield* pipe(
        HttpClientRequest.post("/todos"),
        HttpClientRequest.urlParamsBody({ id: "1", title: "test" }),
        client,
        Effect.scoped
      )
      expect(todo).toEqual({ id: 1, title: "test" })
    }).pipe(Effect.scoped, runPromise))

  it("schemaBodyUrlParams error", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.get(
          "/todos",
          Effect.flatMap(
            HttpServerRequest.schemaBodyUrlParams(Schema.Struct({
              id: Schema.NumberFromString,
              title: Schema.String
            })),
            ({ id, title }) => todoResponse({ id, title })
          )
        ),
        HttpRouter.catchTag("ParseError", (error) => HttpServerResponse.unsafeJson({ error }, { status: 400 })),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const response = yield* pipe(
        HttpClientRequest.get("/todos"),
        client,
        Effect.scoped
      )
      expect(response.status).toEqual(400)
    }).pipe(Effect.scoped, runPromise))

  it("schemaBodyFormJson", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const result = yield* HttpServerRequest.schemaBodyFormJson(Schema.Struct({
              test: Schema.String
            }))("json")

            expect(result.test).toEqual("content")
            return HttpServerResponse.empty()
          })
        ),
        Effect.tapErrorCause(Effect.logError),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const formData = new FormData()
      formData.append("json", JSON.stringify({ test: "content" }))
      const response = yield* pipe(
        client(HttpClientRequest.post("/upload", { body: HttpBody.formData(formData) })),
        Effect.scoped
      )
      expect(response.status).toEqual(204)
    }).pipe(Effect.scoped, runPromise))

  it("schemaBodyFormJson file", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const result = yield* HttpServerRequest.schemaBodyFormJson(Schema.Struct({
              test: Schema.String
            }))("json")

            expect(result.test).toEqual("content")
            return HttpServerResponse.empty()
          })
        ),
        Effect.tapErrorCause(Effect.logError),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const formData = new FormData()
      formData.append(
        "json",
        new Blob([JSON.stringify({ test: "content" })], { type: "application/json" }),
        "test.json"
      )
      const response = yield* pipe(
        client(HttpClientRequest.post("/upload", { body: HttpBody.formData(formData) })),
        Effect.scoped
      )
      expect(response.status).toEqual(204)
    }).pipe(Effect.scoped, runPromise))

  it("schemaBodyFormJson url encoded", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.post(
          "/upload",
          Effect.gen(function*(_) {
            const result = yield* HttpServerRequest.schemaBodyFormJson(Schema.Struct({
              test: Schema.String
            }))("json")

            expect(result.test).toEqual("content")
            return HttpServerResponse.empty()
          })
        ),
        Effect.tapErrorCause(Effect.logError),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const response = yield* pipe(
        client(
          HttpClientRequest.post("/upload", {
            body: HttpBody.urlParams(UrlParams.fromInput({
              json: JSON.stringify({ test: "content" })
            }))
          })
        ),
        Effect.scoped
      )
      expect(response.status).toEqual(204)
    }).pipe(Effect.scoped, runPromise))

  it("tracing", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.get(
          "/",
          Effect.flatMap(
            Effect.currentSpan,
            (_) => HttpServerResponse.json({ spanId: _.spanId, parent: _.parent })
          )
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const requestSpan = yield* Effect.makeSpan("client request")
      const body = yield* pipe(
        client(HttpClientRequest.get("/")),
        HttpClientResponse.json,
        Effect.withTracer(Tracer.make({
          span(name, parent, _, __, ___, kind) {
            assert.strictEqual(name, "http.client GET")
            assert.strictEqual(kind, "client")
            assert(parent._tag === "Some" && parent.value._tag === "Span")
            assert.strictEqual(parent.value.name, "request parent")
            return requestSpan
          },
          context(f, _fiber) {
            return f()
          }
        })),
        Effect.withSpan("request parent"),
        Effect.repeatN(2)
      )
      expect((body as any).parent.value.spanId).toEqual(requestSpan.spanId)
    }).pipe(Effect.scoped, runPromise))

  it("client abort", () =>
    Effect.gen(function*(_) {
      const latch = yield* Deferred.make<HttpServerResponse.HttpServerResponse>()
      yield* pipe(
        HttpServerResponse.empty(),
        Effect.delay(1000),
        Effect.interruptible,
        HttpServer.serveEffect((app) => Effect.onExit(app, (exit) => Deferred.complete(latch, exit)))
      )
      const client = yield* makeClient
      const fiber = yield* pipe(client(HttpClientRequest.get("/")), Effect.scoped, Effect.fork)
      yield* Effect.sleep(100)
      yield* Fiber.interrupt(fiber)
      const cause = yield* pipe(Deferred.await(latch), Effect.sandbox, Effect.flip)
      expect(HttpServerError.isClientAbortCause(cause)).toEqual(true)
    }).pipe(Effect.scoped, runPromise))

  it("multiplex", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpMultiplex.empty,
        HttpMultiplex.hostExact("a.example.com", HttpServerResponse.text("A")),
        HttpMultiplex.hostStartsWith("b.", HttpServerResponse.text("B")),
        HttpMultiplex.hostRegex(/^c\.example/, HttpServerResponse.text("C")),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      expect(
        yield* pipe(
          client(
            HttpClientRequest.get("/").pipe(
              HttpClientRequest.setHeader("host", "a.example.com")
            )
          ),
          HttpClientResponse.text
        )
      ).toEqual("A")
      expect(
        yield* pipe(
          client(
            HttpClientRequest.get("/").pipe(
              HttpClientRequest.setHeader("host", "b.example.com")
            )
          ),
          HttpClientResponse.text
        )
      ).toEqual("B")
      expect(
        yield* pipe(
          client(
            HttpClientRequest.get("/").pipe(
              HttpClientRequest.setHeader("host", "b.org")
            )
          ),
          HttpClientResponse.text
        )
      ).toEqual("B")
      expect(
        yield* pipe(
          client(
            HttpClientRequest.get("/").pipe(
              HttpClientRequest.setHeader("host", "c.example.com")
            )
          ),
          HttpClientResponse.text
        )
      ).toEqual("C")
    }).pipe(Effect.scoped, runPromise))

  it("html", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.get("/home", HttpServerResponse.html("<html />")),
        HttpRouter.get(
          "/about",
          HttpServerResponse.html`<html>${Effect.succeed("<body />")}</html>`
        ),
        HttpRouter.get(
          "/stream",
          HttpServerResponse.htmlStream`<html>${Stream.make("<body />", 123, "hello")}</html>`
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const home = yield* pipe(HttpClientRequest.get("/home"), client, HttpClientResponse.text)
      expect(home).toEqual("<html />")
      const about = yield* pipe(HttpClientRequest.get("/about"), client, HttpClientResponse.text)
      expect(about).toEqual("<html><body /></html>")
      const stream = yield* pipe(HttpClientRequest.get("/stream"), client, HttpClientResponse.text)
      expect(stream).toEqual("<html><body />123hello</html>")
    }).pipe(Effect.scoped, runPromise))

  it("setCookie", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.get(
          "/home",
          HttpServerResponse.empty().pipe(
            HttpServerResponse.unsafeSetCookie("test", "value"),
            HttpServerResponse.unsafeSetCookie("test2", "value2", {
              httpOnly: true,
              secure: true,
              sameSite: "lax",
              partitioned: true,
              path: "/",
              domain: "example.com",
              expires: new Date(2022, 1, 1, 0, 0, 0, 0),
              maxAge: "5 minutes"
            })
          )
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const res = yield* pipe(HttpClientRequest.get("/home"), client, Effect.scoped)
      assert.deepStrictEqual(
        res.cookies.toJSON(),
        Cookies.fromReadonlyRecord({
          test: Cookies.unsafeMakeCookie("test", "value"),
          test2: Cookies.unsafeMakeCookie("test2", "value2", {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            partitioned: true,
            path: "/",
            domain: "example.com",
            expires: new Date(2022, 1, 1, 0, 0, 0, 0),
            maxAge: Duration.minutes(5)
          })
        }).toJSON()
      )
    }).pipe(Effect.scoped, runPromise))

  it("uninterruptible routes", () =>
    Effect.gen(function*(_) {
      yield* pipe(
        HttpRouter.empty,
        HttpRouter.get(
          "/home",
          Effect.gen(function*(_) {
            const fiber = Option.getOrThrow(Fiber.getCurrentFiber())
            setTimeout(() => fiber.unsafeInterruptAsFork(fiber.id()), 10)
            return yield* pipe(HttpServerResponse.empty(), Effect.delay(50))
          }),
          { uninterruptible: true }
        ),
        HttpServer.serveEffect()
      )
      const client = yield* makeClient
      const res = yield* pipe(HttpClientRequest.get("/home"), client, Effect.scoped)
      assert.strictEqual(res.status, 204)
    }).pipe(Effect.scoped, runPromise))
})
