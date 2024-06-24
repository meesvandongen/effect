import * as Worker from "@effect/platform/Worker"
import { WorkerError } from "@effect/platform/WorkerError"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"

const platformWorkerImpl = Worker.PlatformWorker.of({
  [Worker.PlatformWorkerTypeId]: Worker.PlatformWorkerTypeId,
  spawn<I, O>(worker_: unknown) {
    return Effect.gen(function*(_) {
      const worker = worker_ as globalThis.SharedWorker | globalThis.Worker | MessagePort
      let port: globalThis.Worker | MessagePort
      if ("port" in worker) {
        port = worker.port
      } else {
        port = worker
      }

      yield* Effect.addFinalizer(() => Effect.sync(() => port.postMessage([1])))

      const queue = yield* Queue.unbounded<Worker.BackingWorker.Message<O>>()
      const latch = yield* Deferred.make<void>()

      const fiber = yield* pipe(
        Effect.async<never, WorkerError, never>((resume) => {
          function onMessage(event: MessageEvent) {
            queue.unsafeOffer((event as MessageEvent).data)
          }
          function onError(event: ErrorEvent) {
            resume(new WorkerError({ reason: "unknown", error: event.error ?? event.message }))
          }
          port.addEventListener("message", onMessage as any)
          port.addEventListener("error", onError as any)
          Deferred.unsafeDone(latch, Effect.void)
          return Effect.sync(() => {
            port.removeEventListener("message", onMessage as any)
            port.removeEventListener("error", onError as any)
          })
        }),
        Effect.interruptible,
        Effect.forkScoped
      )
      yield* Deferred.await(latch)

      if ("start" in port) {
        port.start()
      }

      const send = (message: I, transfers?: ReadonlyArray<unknown>) =>
        Effect.try({
          try: () => port.postMessage([0, message], transfers as any),
          catch: (error) => new WorkerError({ reason: "send", error })
        })

      return { fiber, queue, send }
    })
  }
})

/** @internal */
export const layerWorker = Layer.succeed(Worker.PlatformWorker, platformWorkerImpl)

/** @internal */
export const layerManager = Layer.provide(Worker.layerManager, layerWorker)

/** @internal */
export const layer = (spawn: (id: number) => globalThis.Worker | globalThis.SharedWorker | MessagePort) =>
  Layer.merge(layerManager, Worker.layerSpawner(spawn))
