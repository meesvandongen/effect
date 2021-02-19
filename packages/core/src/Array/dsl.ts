import type * as O from "../Option"
import * as P from "../Prelude"
import { isOption } from "../Utils"
import { Applicative, ApplyZip, Covariant, ForEach, Monad } from "./instances"
import type * as A from "./operations"

export const sequence = P.sequenceF(ForEach)

const adapter: {
  <A>(_: () => O.Option<A>): P.GenLazyHKT<A.Array<A>, A>
  <A>(_: () => A.Array<A>): P.GenLazyHKT<A.Array<A>, A>
} = (_: () => any) =>
  new P.GenLazyHKT(() => {
    const x = _()
    if (isOption(x)) {
      return x._tag === "None" ? [] : [x.value]
    }
    return x
  })

export const gen = P.genWithHistoryF(Monad, {
  adapter
})

export const tupleZip = P.tupleF(ApplyZip)

export const structZip = P.structF(ApplyZip)

export const tuple = P.tupleF(Applicative)

export const struct = P.structF(Applicative)

const do_ = P.doF(Monad)()

export const bind = P.bindF(Monad)

const let_ = P.letF(Monad)

export { do_ as do, let_ as let }

/**
 * Matchers
 */
export const { match, matchIn, matchMorph, matchTag, matchTagIn } = P.matchers(
  Covariant
)

/**
 * Conditionals
 */
const branch = P.conditionalF(Covariant)
const branch_ = P.conditionalF_(Covariant)

export { branch as if, branch_ as if_ }
