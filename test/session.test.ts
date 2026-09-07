import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionToken,
  verifySessionToken,
  SESSION_MAX_AGE_SECONDS,
} from '../lib/session.ts'

const SECRET = 'session-secret'

test('a freshly minted token verifies against the same secret', async () => {
  const token = await createSessionToken(SECRET)
  assert.equal(await verifySessionToken(token, SECRET), true)
})

test('a token is rejected under a different secret', async () => {
  const token = await createSessionToken(SECRET)
  assert.equal(await verifySessionToken(token, 'other-secret'), false)
})

test('an expired token is rejected', async () => {
  const issued = Date.now() - (SESSION_MAX_AGE_SECONDS + 60) * 1000
  const token = await createSessionToken(SECRET, issued)
  assert.equal(await verifySessionToken(token, SECRET), false)
})

test('the expiry cannot be extended without re-signing', async () => {
  const token = await createSessionToken(SECRET)
  const signature = token.slice(token.indexOf('.') + 1)
  const forged = `${Date.now() + 10 * 365 * 24 * 3600 * 1000}.${signature}`
  assert.equal(await verifySessionToken(forged, SECRET), false)
})

test('malformed and missing tokens are rejected rather than throwing', async () => {
  for (const bad of [undefined, '', '.', 'nodot', 'abc.def', '.sig', '12x34.sig']) {
    assert.equal(await verifySessionToken(bad, SECRET), false, `${String(bad)} should fail`)
  }
})
