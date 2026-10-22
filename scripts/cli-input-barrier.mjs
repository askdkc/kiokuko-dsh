/** Pace one-shot PTY submissions from observed handling, never from write time.
 * The CLI collapses Enter events within 80 ms. A write may sit in the PTY queue
 * arbitrarily long, so elapsed time since write cannot establish readiness.
 */
export function createInputBarrier({ now = () => performance.now(), settleMs = 100 } = {}) {
  let pending, handledAt
  return {
    ready() {
      if (pending) {
        if (!pending()) return false
        pending = undefined
        handledAt = now()
      }
      return handledAt === undefined || now() - handledAt >= settleMs
    },
    submitted(handled) {
      if (!this.ready()) throw new Error('Previous Enter has not settled after observed handling')
      if (typeof handled !== 'function') throw new TypeError('An Enter handling observation is required')
      pending = handled
    },
  }
}

/** UI handling evidence is only a pacing barrier, never proof of admission. */
export function inputWasHandled({ exited, submittedFrame, frame, composer, freshQuestionVisible }) {
  return Boolean(exited) || frame > submittedFrame &&
    (composer === '' || composer === undefined && freshQuestionVisible)
}

/** Observe the public question waterfall without changing its answer or errors. */
export function createQuestionObserver(record) {
  let sequence = 0
  return async (request, next) => {
    const requestSequence = ++sequence
    record({ type: 'native-question', requestSequence, questions: request.questions })
    try {
      const answer = await next()
      record({ type: 'native-question-response', requestSequence, outcome: 'answered', answers: answer.answers })
      return answer
    } catch (error) {
      record({ type: 'native-question-response', requestSequence, outcome: 'rejected', error: String(error), code: error?.code })
      throw error
    }
  }
}

/** Match a fresh answer to the submitted request instance, not transcript text. */
export function questionWasAnswered({ events, eventOffset, requestSequence, questionId, selected }) {
  return events.slice(eventOffset).some(event => event.type === 'native-question-response'
    && event.requestSequence === requestSequence && event.outcome === 'answered'
    && event.answers?.some(answer => answer.id === questionId && Array.isArray(answer.selected)
      && answer.selected.length === selected.length && answer.selected.every((label, index) => label === selected[index])))
}
