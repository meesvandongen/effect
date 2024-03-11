/**
 * @since 2.0.0
 */

import type { NonEmptyArray, NonEmptyReadonlyArray } from "../ReadonlyArray.js"

/** @internal */
export const isNonEmpty: {
  <A>(self: Array<A>): self is NonEmptyArray<A>
  <A>(self: ReadonlyArray<A>): self is NonEmptyReadonlyArray<A>
} = <A>(self: ReadonlyArray<A>): self is NonEmptyArray<A> => self.length > 0
