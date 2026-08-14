// `hermes config set` is read-modify-write on ~/.hermes/config.yaml with only an
// IN-PROCESS lock — five concurrent setter processes all read the same snapshot and
// the last writer wins, silently dropping the other keys. On a fresh venv (first
// bootstrap, or right after "Baiki enjin Sarä") that left model.provider=minimax but
// LOST model.base_url + model.api_key, so hermes called api.minimax.io directly and
// every task 401'd (mfimf laptop, 2026-08-14). These tests pin the fix: config writes
// run strictly one-at-a-time, and overlapping ensureHermesConfig() invocations
// (boot + post-bootstrap + repair) join one queue instead of racing each other.
const test = require('node:test')
const assert = require('node:assert')
const { queueHermesConfigWrites } = require('./sara-connector.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('config writes within one call run strictly serially', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const order = []
  await queueHermesConfigWrites(
    [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ],
    async (k) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(10)
      order.push(k)
      inFlight -= 1
    }
  )
  assert.strictEqual(maxInFlight, 1, 'setters must never overlap')
  assert.deepStrictEqual(order, ['a', 'b', 'c'], 'setters must run in declaration order')
})

test('overlapping invocations join one queue (boot + repair cannot interleave)', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const order = []
  const runOne = async (k) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(5)
    order.push(k)
    inFlight -= 1
  }
  const first = queueHermesConfigWrites([['boot.a', '1'], ['boot.b', '2']], runOne)
  const second = queueHermesConfigWrites([['repair.a', '1'], ['repair.b', '2']], runOne)
  await Promise.all([first, second])
  assert.strictEqual(maxInFlight, 1, 'queues from separate calls must not overlap')
  assert.deepStrictEqual(order, ['boot.a', 'boot.b', 'repair.a', 'repair.b'])
})

test('a throwing setter does not kill the rest of the queue', async () => {
  const order = []
  await queueHermesConfigWrites(
    [
      ['a', '1'],
      ['boom', 'x'],
      ['c', '3'],
    ],
    async (k) => {
      if (k === 'boom') throw new Error('spawn failed')
      order.push(k)
    }
  )
  await queueHermesConfigWrites([['d', '4']], async (k) => order.push(k))
  assert.deepStrictEqual(order, ['a', 'c', 'd'], 'best-effort: later keys and later calls still run')
})