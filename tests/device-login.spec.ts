import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import {
  DeviceLoginError,
  DEVICE_LOGIN_ENDPOINTS,
  startDeviceLogin,
  waitForDeviceLogin,
} from '../src/device-login.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** A fetch double that answers a scripted list of envelopes and records the requests. */
interface Scripted {
  fetcher: typeof fetch
  calls: { url: string, method: string, headers: Record<string, string>, body?: string }[]
}

/**
 * A fetch double answering a scripted list of JSON envelopes, repeating the last
 * one once the list runs out. The last entries are what make a poll loop
 * terminate, so repetition is the honest default; call sites that need a second
 * phase just extend the list.
 */
function scriptedFetch(answers: ScriptedAnswer[]): Scripted {
  const calls: Scripted['calls'] = []
  let index = 0
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...init?.body === undefined || init.body === null ? {} : { body: String(init.body) },
    })
    const answer = answers[Math.min(index, answers.length - 1)]!
    index += 1
    const envelope = 'body' in answer ? answer.body : answer
    return new Response(JSON.stringify(envelope), {
      status: 'status' in answer ? answer.status : 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetcher, calls }
}

/** One scripted answer: an envelope, or a non-200 response wrapping one. */
type ScriptedAnswer = EnvelopeObject | { status: number, body: EnvelopeObject }

/** The `{code,msg,data}` shape the sign-in endpoints answer with; `data` is absent on some failures. */
interface EnvelopeObject {
  code: number
  msg: string
  data?: unknown
}

const ENVELOPE = (data: unknown, code = 0, msg = '') => ({ code, msg, data })
const PENDING = ENVELOPE({}, 11217, '11217:login ing...')

/** A token answer the CN product's endpoint would give once approved. */
const APPROVED = ENVELOPE({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 3600,
  domain: 'www.codebuddy.cn',
})

const ACCOUNT = ENVELOPE({ uid: 'uid-9', nickname: '阿凉', enterpriseId: '' })

async function tempStore(overrides: { variant?: typeof CN_VARIANT } = {}): Promise<WorkBuddyCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-login-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return new WorkBuddyCredentialStore({
    ...overrides.variant === undefined ? {} : { variant: overrides.variant },
    desktopPath: join(dir, 'absent-desktop.info'),
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
}

const noSleep = async (): Promise<void> => {}

describe('startDeviceLogin', () => {
  it('asks the CN state endpoint with the CLI client identity', async () => {
    const { fetcher, calls } = scriptedFetch([
      ENVELOPE({ state: 'state-1', authUrl: 'https://copilot.tencent.com/login?state=state-1' }),
    ])
    const session = await startDeviceLogin(CN_VARIANT, { fetcher })
    expect(session).toEqual({
      state: 'state-1',
      authUrl: 'https://copilot.tencent.com/login?state=state-1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(DEVICE_LOGIN_ENDPOINTS.cn.state)
    expect(calls[0]!.headers['User-Agent']).toContain('CodeBuddy')
    expect(calls[0]!.headers['Origin']).toBe('https://www.codebuddy.cn')
  })

  it('uses the international endpoints for the AI variant', async () => {
    const { fetcher, calls } = scriptedFetch([
      ENVELOPE({ state: 'state-2', authUrl: 'https://www.workbuddy.ai/login?state=state-2' }),
    ])
    await startDeviceLogin(AI_VARIANT, { fetcher })
    expect(calls[0]!.url).toBe(DEVICE_LOGIN_ENDPOINTS.global.state)
    expect(calls[0]!.headers['Origin']).toBe('https://www.workbuddy.ai')
  })

  it('refuses an answer without a state or URL', async () => {
    const { fetcher } = scriptedFetch([ENVELOPE({ state: 'only-state' })])
    await expect(startDeviceLogin(CN_VARIANT, { fetcher })).rejects.toMatchObject({
      name: 'DeviceLoginError',
      code: 'state-failed',
    })
  })
})

describe('waitForDeviceLogin', () => {
  it('polls while pending and resolves the approved credential', async () => {
    const { fetcher, calls } = scriptedFetch([
      PENDING,
      PENDING,
      APPROVED,
      ACCOUNT,
    ])
    const credential = await waitForDeviceLogin(CN_VARIANT, 'state-1', { fetcher, sleep: noSleep })
    expect(credential.accessToken).toBe('access-1')
    expect(credential.refreshToken).toBe('refresh-1')
    expect(credential.uid).toBe('uid-9')
    expect(credential.nickname).toBe('阿凉')
    expect(credential.domain).toBe('www.codebuddy.cn')
    expect(credential.source).toBe('dsh')
    // expiresIn is seconds on the wire and milliseconds in the credential.
    expect(credential.expiresAtMs).toBeGreaterThan(Date.now() + 3500_000)
    expect(credential.enterpriseId).toBeUndefined()

    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET', 'GET'])
    expect(calls[0]!.url).toBe(`${DEVICE_LOGIN_ENDPOINTS.cn.token}state-1`)
    // The account endpoint is asked with the freshly issued access token.
    expect(calls[3]!.headers['Authorization']).toBe('Bearer access-1')
  })

  it('still signs in when the account endpoint fails', async () => {
    const { fetcher } = scriptedFetch([
      APPROVED,
      { status: 500, body: { code: 500, msg: 'boom' } },
    ])
    const credential = await waitForDeviceLogin(CN_VARIANT, 'state-1', { fetcher, sleep: noSleep })
    expect(credential.accessToken).toBe('access-1')
    expect(credential.uid).toBe('')
  })

  it('gives up after the timeout budget', async () => {
    const { fetcher } = scriptedFetch([PENDING])
    let clock = 0
    const error = await waitForDeviceLogin(CN_VARIANT, 'state-1', {
      fetcher,
      sleep: async () => { clock += 1000 },
      now: () => clock,
      timeoutMs: 5000,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeviceLoginError)
    expect((error as DeviceLoginError).code).toBe('timeout')
  })

  it('rejects an account approved for the other product', async () => {
    const { fetcher } = scriptedFetch([
      ENVELOPE({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, domain: 'www.workbuddy.ai' }),
      ACCOUNT,
    ])
    const error = await waitForDeviceLogin(CN_VARIANT, 'state-1', { fetcher, sleep: noSleep })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeviceLoginError)
    expect((error as DeviceLoginError).code).toBe('region-mismatch')
    expect((error as Error).message).toContain('--provider workbuddy-ai')
  })

  it('stops polling when the caller aborts', async () => {
    const { fetcher, calls } = scriptedFetch([PENDING])
    const controller = new AbortController()
    controller.abort()
    await expect(waitForDeviceLogin(CN_VARIANT, 'state-1', {
      fetcher,
      signal: controller.signal,
      sleep: async (_ms, signal) => {
        if (signal?.aborted === true) throw new DeviceLoginError('aborted', 'device login cancelled')
      },
    })).rejects.toMatchObject({ code: 'aborted' })
    expect(calls.length).toBeLessThanOrEqual(1)
  })
})

describe('WorkBuddyCredentialStore.adopt', () => {
  it('persists a device-login credential as the plugin-owned copy', async () => {
    const store = await tempStore()
    const adopted = await store.adopt({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAtMs: Date.now() + 3600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-9',
      source: 'dsh',
    })
    expect(adopted.source).toBe('dsh')
    // With no desktop file present, the copy is the credential the host serves.
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'access-1', uid: 'uid-9' })
  })

  it('refuses the other product\'s credential', async () => {
    const store = await tempStore({ variant: CN_VARIANT })
    await expect(store.adopt({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 0,
      domain: 'www.workbuddy.ai',
      uid: 'uid-9',
      source: 'dsh',
    })).rejects.toThrow(/WorkBuddy AI/)
  })

  it('refuses an empty access token', async () => {
    const store = await tempStore()
    await expect(store.adopt({
      accessToken: '',
      refreshToken: 'refresh-1',
      expiresAtMs: 0,
      domain: '',
      uid: '',
      source: 'dsh',
    })).rejects.toThrow(/empty access token/)
  })
})
