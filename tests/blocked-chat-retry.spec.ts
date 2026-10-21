import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { ChatIdentity } from '../src/client-identity.ts'
import {
  blockedChatWantsRetry,
  prepareCnChatBody,
  prepareInternationalChatBody,
  WorkBuddyUpstreamClient,
} from '../src/upstream.ts'

/**
 * The CN gateway refuses some chat requests with `400` / `code 11128`
 * ("Illegal API invocation from an unapproved channel") and a display message
 * that literally asks the client to send the request again. That refusal is
 * transient, so the client resends **once** and only for that shape — a
 * malformed request must never be sent twice, because every attempt spends the
 * account's credit.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}

const IDENTITY: ChatIdentity = { clientVersion: '5.5.6', cliVersion: '2.137.1' }

const BLOCKED = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  displayMsg: { zh: '请求被拦截，请重新发送', en: 'Request blocked. Please send it again' },
  actions: ['RETRY', 'SUBMIT_FEEDBACK'],
})

function fakeResponse(body: string, ok: boolean, status: number): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

/** Stub fetch with a scripted queue of responses and expose every call. */
function scripted(responses: Response[]) {
  let index = 0
  const fetchMock = vi.fn(async () => responses[Math.min(index++, responses.length - 1)]!)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

const BODY = JSON.stringify({ model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }] })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('blockedChatWantsRetry', () => {
  it('accepts the 11128 channel refusal', () => {
    expect(blockedChatWantsRetry(400, BLOCKED)).toBe(true)
  })

  it('accepts any 400 that names RETRY in actions', () => {
    expect(blockedChatWantsRetry(400, JSON.stringify({ code: 99999, actions: ['RETRY'] }))).toBe(true)
  })

  it('refuses other 400s, so a malformed request is never doubled', () => {
    expect(blockedChatWantsRetry(400, JSON.stringify({ code: 11140, msg: 'request illegal' }))).toBe(false)
    expect(blockedChatWantsRetry(400, JSON.stringify({ code: 11101, msg: 'Non-stream chat request' }))).toBe(false)
    expect(blockedChatWantsRetry(400, 'plain text refusal')).toBe(false)
  })

  it('refuses statuses outside 400 (credit, rate, auth keep one attempt)', () => {
    expect(blockedChatWantsRetry(402, BLOCKED)).toBe(false)
    expect(blockedChatWantsRetry(429, BLOCKED)).toBe(false)
    expect(blockedChatWantsRetry(401, BLOCKED)).toBe(false)
    expect(blockedChatWantsRetry(500, BLOCKED)).toBe(false)
  })
})

describe('chatStream retry on a gateway-requested resend', () => {
  it('resends once and returns the accepted answer', async () => {
    const fetchMock = scripted([
      fakeResponse(BLOCKED, false, 400),
      fakeResponse(': heartbeat\ndata: {}\n', true, 200),
    ])
    const result = await client().chatStream(CN, BODY)
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('mints a fresh conversation trio for the resend', async () => {
    const fetchMock = scripted([
      fakeResponse(BLOCKED, false, 400),
      fakeResponse(': heartbeat\n', true, 200),
    ])
    await client().chatStream(CN, BODY)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const headersOf = (init: RequestInit) => init.headers as Record<string, string>
    const first = headersOf(calls[0]![1])
    const second = headersOf(calls[1]![1])
    for (const name of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) {
      expect(first[name]).toBeDefined()
      expect(second[name]).toBeDefined()
      expect(second[name]).not.toBe(first[name])
    }
  })

  it('gives up after the single resend', async () => {
    const fetchMock = scripted([fakeResponse(BLOCKED, false, 400)])
    const result = await client().chatStream(CN, BODY)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ status: 400, kind: 'client' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never doubles a non-retryable rejection', async () => {
    const fetchMock = scripted([
      fakeResponse(JSON.stringify({ code: 11140, msg: 'request illegal' }), false, 400),
    ])
    const result = await client().chatStream(CN, BODY)
    expect(result.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not resend when the caller already aborted', async () => {
    const fetchMock = scripted([fakeResponse(BLOCKED, false, 400)])
    const controller = new AbortController()
    controller.abort()
    const result = await client().chatStream(CN, BODY, controller.signal)
    expect(result.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('CN body normalization', () => {
  it('rewrites the developer role the CN gateway rejects with 11128', () => {
    const prepared = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'developer', content: 'S' }, { role: 'user', content: 'hi' }],
    }))) as { stream: boolean, messages: { role: string }[] }
    expect(prepared.messages[0]!.role).toBe('system')
    expect(prepared.stream).toBe(true)
  })

  it('stays idempotent when the body was already prepared', () => {
    const once = prepareCnChatBody(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'developer', content: 'S' }],
    }))
    expect(prepareCnChatBody(once)).toBe(once)
  })

  it('matches the international path on role and stream', () => {
    const source = JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'developer', content: 'S' }],
    })
    const cn = JSON.parse(prepareCnChatBody(source)) as { stream: boolean, messages: { role: string }[] }
    const intl = JSON.parse(prepareInternationalChatBody(source)) as { stream: boolean, messages: { role: string }[] }
    expect(cn.messages[0]!.role).toBe(intl.messages[0]!.role)
    expect(cn.stream).toBe(intl.stream)
  })
})
