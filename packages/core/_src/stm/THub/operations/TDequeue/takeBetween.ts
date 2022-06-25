/**
 * Takes a number of elements from the queue between the specified minimum and
 * maximum. If there are fewer than the minimum number of elements available,
 * retries until at least the minimum number of elements have been collected.
 *
 * @tsplus fluent ets/THub/TDequeue takeBetween
 */
export function takeBetween_<A>(self: THub.TDequeue<A>, min: number, max: number): USTM<Chunk<A>> {
  return STM.suspend(() => self.takeRemainder(min, max, Chunk.empty<A>()))
}

/**
 * Takes a number of elements from the queue between the specified minimum and
 * maximum. If there are fewer than the minimum number of elements available,
 * retries until at least the minimum number of elements have been collected.
 *
 * @tsplus static ets/THub/TDequeue/Aspects takeBetween
 */
export const takeBetween = Pipeable(takeBetween_)