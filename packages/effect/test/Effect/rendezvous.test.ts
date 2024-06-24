import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as it from "effect/test/utils/extend"
import * as TestClock from "effect/TestClock"
import { assert, describe } from "vitest"

describe("Effect", () => {
  it.effect("bounded 0 is rendezvous", () =>
    Effect.gen(function*(_) {
      const rendevous = yield* Queue.bounded<string>(0)
      const logs: Array<string> = []

      const fiber = yield* Effect.fork(
        Effect.gen(function*(_) {
          yield* Effect.sleep("50 millis")
          logs.push("sending message")
          yield* Queue.offer(rendevous, "Hello World")
          logs.push("sent message")
        })
      )

      const fiber2 = yield* Effect.fork(
        Effect.gen(function*(_) {
          yield* Effect.sleep("100 millis")
          logs.push("receiving message")
          const message = yield* Queue.take(rendevous)
          logs.push("received message")
          logs.push(message)
        })
      )

      yield* TestClock.adjust("200 millis")

      yield* Fiber.join(Fiber.zip(fiber, fiber2))

      assert.deepEqual(logs, [
        "sending message",
        "receiving message",
        "received message",
        "Hello World",
        "sent message"
      ])
    }))
})
