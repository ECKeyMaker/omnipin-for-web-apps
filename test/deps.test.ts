import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import { randomInt, setTimeout, styleText } from '../src/deps.js'

describe('deps', () => {
  it('randomInt stays in range', () => {
    for (let i = 0; i < 1000; i++) {
      const value = randomInt(7)
      assert.ok(Number.isInteger(value) && value >= 0 && value < 7)
    }
  })

  it('randomInt rejects an invalid range', () => {
    assert.throws(() => randomInt(0), RangeError)
    assert.throws(() => randomInt(2 ** 33), RangeError)
  })

  it('setTimeout resolves after the delay', async () => {
    const start = performance.now()
    await setTimeout(5)
    assert.ok(performance.now() - start >= 4)
  })

  it('styleText leaves text intact when output is not a TTY', () => {
    // The test runner pipes stdout, so isTTY is false here.
    assert.strictEqual(styleText('bold', 'text'), 'text')
  })
})
