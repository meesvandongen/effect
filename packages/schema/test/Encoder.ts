import { pipe } from "@fp-ts/data/Function"
import * as E from "@fp-ts/schema/Encoder"
import * as S from "@fp-ts/schema/Schema"

const stringId = Symbol.for("@fp-ts/schema/test/Encoder/string")

const string = pipe(
  S.string,
  S.clone(stringId, {
    [E.EncoderId]: () => E.make(string, (s) => s + "!")
  })
)

const numberId = Symbol.for("@fp-ts/schema/test/Encoder/number")

const number = pipe(
  S.number,
  S.clone(numberId, {
    [E.EncoderId]: () => E.make(number, (n) => n * 2)
  })
)

describe("Encoder", () => {
  it("tuple", () => {
    const schema = S.tuple(string, number)
    const encoder = E.encoderFor(schema)
    expect(encoder.encode(["a", 1])).toEqual(["a!", 2])
  })

  it("union", () => {
    const schema = S.union(string, number)
    const encoder = E.encoderFor(schema)
    expect(encoder.encode("a")).toEqual("a!")
    expect(encoder.encode(1)).toEqual(2)
  })

  it("struct", () => {
    const schema = S.struct({
      a: string,
      b: number
    })
    const encoder = E.encoderFor(schema)
    expect(encoder.encode({ a: "a", b: 1 })).toEqual({ a: "a!", b: 2 })
  })
})