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

/** Drive a single-select question from rendered focus, not queued key writes.
 * Down and Enter in one stdin batch can share the CLI's old React focus closure.
 * Each move therefore needs a newer frame showing its exact expected option.
 * No timeout/repaint alone can release Enter, and no input is ever retried.
 */
export function createQuestionSelection(question, selected) {
  const labels = question.options?.map(option => option.label) ?? []
  const target = labels.indexOf(selected)
  if (question.multiSelect || target < 0 || new Set(labels).size !== labels.length
    || typeof question.question !== 'string' || !question.question.trim())
    throw new Error('Expected a unique single-select option')
  let pending, submitted = false
  return ({ screen, frame, active = true }) => {
    if (!active || submitted) return undefined
    const screenRows = screen.split('\n').map(row => row.trim())
    const header = screenRows.findLastIndex(row => /(?:^|\s)📋 Question \d+\/\d+(?:\s|$)/u.test(row))
    if (header < 0) return undefined
    const rows = screenRows.slice(header + 1)
    // These probe questions fit on one line. Historical text above the active
    // panel or another question reusing its labels cannot identify this request.
    if (!rows.includes(question.question.trim())) return undefined
    const focused = labels.map((label, index) => rows.includes(`❯● ${label}`) ? index : -1).filter(index => index >= 0)
    if (focused.length !== 1) return undefined
    const index = focused[0]
    if (pending) {
      if (frame <= pending.frame || index !== pending.index) return undefined
      pending = undefined
    }
    if (index === target) { submitted = true; return 'submit' }
    // Only move through real options, never through the custom-input tail.
    const delta = target > index ? 1 : -1
    pending = { frame, index: index + delta }
    return delta > 0 ? 'down' : 'up'
  }
}
