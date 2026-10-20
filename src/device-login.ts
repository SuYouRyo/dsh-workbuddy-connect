/**
 * Device-code sign-in for hosts that have no WorkBuddy desktop app.
 *
 * The plugin normally reuses the desktop app's sign-in: it reads the auth file
 * that app leaves behind and, when those token fields are encrypted, asks the
 * app's own Electron binary for the at-rest key. Neither half exists on a
 * phone or on a headless Linux box, so those hosts previously had no way to
 * *obtain* a credential — they could only consume one copied from a desktop.
 *
 * This module closes that gap with the same device authorization flow the
 * official CLI uses, so the plugin can sign itself in on any platform:
 *
 *   POST  {base}/v2/plugin/auth/state?platform=CLI   → { state, authUrl }
 *   GET   {base}/v2/plugin/auth/token?state=…        → tokens once approved
 *   GET   {base}/v2/plugin/login/account?state=…     → uid / nickname / enterprise
 *
 * The user approves the `authUrl` in any browser; the state value is the only
 * correlation token, and it is single-use and short-lived upstream. No PKCE:
 * the server issues `state` itself.
 *
 * What this module deliberately does not do: touch the desktop app's files. It
 * returns a credential; persisting it belongs to {@link WorkBuddyCredentialStore},
 * which writes only the plugin-owned copy.
 *
 * @module dsh-workbuddy-connect/device-login
 */

import type { WorkBuddyCredential } from './auth.ts'
import { regionOf, type WorkBuddyRegion } from './upstream.ts'
import type { WorkBuddyVariant } from './variants.ts'

/** Where one region's device authorization endpoints live. */
export interface DeviceLoginEndpoints {
  /** POST endpoint that mints a state and the URL the user approves. */
  state: string
  /** GET endpoint that answers the issued tokens once approved. */
  token: string
  /** GET endpoint that answers the signed-in account identity. */
  account: string
  /** Origin/Referer base for the request headers of this region. */
  origin: string
}

/**
 * Region table. Kept here rather than in `upstream.ts` because these are
 * sign-in surfaces, not model surfaces: they answer the CLI client identity and
 * carry no chat headers, so the two must not be conflated when either changes.
 */
export const DEVICE_LOGIN_ENDPOINTS: Readonly<Record<WorkBuddyRegion, DeviceLoginEndpoints>> = {
  cn: {
    state: 'https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI',
    token: 'https://copilot.tencent.com/v2/plugin/auth/token?state=',
    account: 'https://copilot.tencent.com/v2/plugin/login/account?state=',
    origin: 'https://www.codebuddy.cn',
  },
  global: {
    state: 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI',
    token: 'https://www.workbuddy.ai/v2/plugin/auth/token?state=',
    account: 'https://www.workbuddy.ai/v2/plugin/login/account?state=',
    origin: 'https://www.workbuddy.ai',
  },
}

/** User-Agent of the official CLI, which these endpoints are written for. */
const CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Per-request HTTP bound; the whole flow is bounded separately. */
const REQUEST_TIMEOUT_MS = 30_000

/** How long a pending authorization is polled before giving up. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000

/** Gap between polls while the authorization is still pending. */
export const DEFAULT_LOGIN_POLL_MS = 3_000

/** A minted authorization the user still has to approve. */
export interface DeviceLoginSession {
  /** Correlation value the token/account endpoints are asked with. */
  state: string
  /** URL to open in any browser; approval there completes the sign-in. */
  authUrl: string
}

/** Why a device login could not finish. Branch on `code`, never on `message`. */
export type DeviceLoginErrorCode =
  | 'state-failed'
  | 'token-failed'
  | 'account-failed'
  | 'region-mismatch'
  | 'timeout'
  | 'aborted'
  | 'incomplete'

/** Typed failure of one device-login stage. */
export class DeviceLoginError extends Error {
  readonly code: DeviceLoginErrorCode

  constructor(code: DeviceLoginErrorCode, message: string) {
    super(message)
    this.name = 'DeviceLoginError'
    this.code = code
  }
}

/** Dependencies a caller may substitute; production defaults are the real clock and fetch. */
export interface DeviceLoginOptions {
  /** Injected HTTP implementation, for tests and proxies. */
  fetcher?: typeof fetch
  /** Cancels the flow (Ctrl-C, plugin disposal). */
  signal?: AbortSignal
  /** Total budget for the pending poll loop. */
  timeoutMs?: number
  /** Gap between polls. */
  pollMs?: number
  /** Clock override, mainly so tests need no real waiting. */
  now?: () => number
  /** Observes each pending poll, for progress output (never receives tokens). */
  onPending?: (attempt: number, elapsedMs: number) => void
  /** Sleep override; tests pass a no-op. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface Envelope {
  code?: number
  msg?: string
  data?: unknown
}

function endpointsFor(variant: WorkBuddyVariant): DeviceLoginEndpoints {
  return DEVICE_LOGIN_ENDPOINTS[variant.region]
}

function headersFor(endpoints: DeviceLoginEndpoints, bearer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': endpoints.origin,
    'Referer': `${endpoints.origin}/`,
    'User-Agent': CLI_UA,
  }
  if (bearer !== undefined && bearer !== '') headers['Authorization'] = `Bearer ${bearer}`
  return headers
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DeviceLoginError('aborted', 'device login cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new DeviceLoginError('aborted', 'device login cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** One request, unwrapped to the `{code,msg,data}` envelope. Throws on transport failure. */
async function callEnvelope(
  url: string,
  init: { method: 'GET' | 'POST'; body?: string; bearer?: string },
  endpoints: DeviceLoginEndpoints,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Envelope> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetcher(url, {
    method: init.method,
    headers: headersFor(endpoints, init.bearer),
    ...init.body === undefined ? {} : { body: init.body },
    signal: combined,
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DeviceLoginError('incomplete', `sign-in endpoint answered HTTP ${response.status} with a non-JSON body`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DeviceLoginError('incomplete', `sign-in endpoint answered HTTP ${response.status} with an unexpected document`)
  }
  return parsed as Envelope
}

function messageOf(envelope: Envelope): string {
  const msg = typeof envelope.msg === 'string' ? envelope.msg.trim() : ''
  if (msg !== '') return `code=${String(envelope.code ?? '?')} msg=${msg}`
  return `code=${String(envelope.code ?? '?')}`
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Mint a fresh authorization for one variant.
 *
 * The returned `authUrl` must be shown to the user; `state` is what
 * {@link waitForDeviceLogin} polls with. Nothing is persisted here.
 */
export async function startDeviceLogin(
  variant: WorkBuddyVariant,
  options: DeviceLoginOptions = {},
): Promise<DeviceLoginSession> {
  const endpoints = endpointsFor(variant)
  const fetcher = options.fetcher ?? fetch
  let envelope: Envelope
  try {
    envelope = await callEnvelope(endpoints.state, { method: 'POST', body: '{}' }, endpoints, fetcher, options.signal)
  } catch (error: unknown) {
    if (error instanceof DeviceLoginError) {
      if (error.code === 'aborted') throw error
      throw new DeviceLoginError('state-failed', error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new DeviceLoginError('state-failed', `could not reach the ${variant.displayName} sign-in service (${message})`)
  }
  if (envelope.code !== 0 && envelope.code !== undefined) {
    throw new DeviceLoginError('state-failed', `sign-in service refused to start a login (${messageOf(envelope)})`)
  }
  const data = recordOf(envelope.data)
  const state = stringOf(data['state'])
  const authUrl = stringOf(data['authUrl'])
  if (state === '' || authUrl === '') {
    throw new DeviceLoginError('state-failed', 'sign-in service answered without a state or an authorization URL')
  }
  return { state, authUrl }
}

/**
 * Poll until the user approves, then resolve the signed-in credential.
 *
 * A pending authorization is not an error upstream: the token endpoint answers
 * a non-zero `code` until approval, so anything but a well-formed token answer
 * is treated as "keep waiting" until {@link DeviceLoginOptions.timeoutMs}.
 */
export async function waitForDeviceLogin(
  variant: WorkBuddyVariant,
  state: string,
  options: DeviceLoginOptions = {},
): Promise<WorkBuddyCredential> {
  const endpoints = endpointsFor(variant)
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_LOGIN_POLL_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const startedAt = now()
  let attempt = 0

  for (;;) {
    attempt += 1
    const envelope = await callEnvelope(
      endpoints.token + encodeURIComponent(state),
      { method: 'GET' },
      endpoints,
      fetcher,
      options.signal,
    ).catch((error: unknown) => {
      if (error instanceof DeviceLoginError && error.code === 'aborted') throw error
      return undefined
    })
    const data = recordOf(envelope?.data)
    const accessToken = stringOf(data['accessToken'])
    if (envelope !== undefined && (envelope.code === 0 || envelope.code === undefined) && accessToken !== '') {
      return await finishLogin(variant, state, data, endpoints, fetcher, options.signal)
    }
    const elapsedMs = now() - startedAt
    if (elapsedMs >= timeoutMs) {
      throw new DeviceLoginError(
        'timeout',
        `authorization was not approved within ${Math.round(timeoutMs / 1000)}s; run login again for a fresh link`,
      )
    }
    options.onPending?.(attempt, elapsedMs)
    await sleep(pollMs, options.signal)
  }
}

/** Turn the token answer plus the account answer into the plugin's credential shape. */
async function finishLogin(
  variant: WorkBuddyVariant,
  state: string,
  tokenData: Record<string, unknown>,
  endpoints: DeviceLoginEndpoints,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<WorkBuddyCredential> {
  const accessToken = stringOf(tokenData['accessToken'])
  const refreshToken = stringOf(tokenData['refreshToken'])
  const expiresIn = typeof tokenData['expiresIn'] === 'number' ? tokenData['expiresIn'] : 0
  const domain = stringOf(tokenData['domain'])

  let uid = ''
  let enterpriseId: string | undefined
  let nickname: string | undefined
  try {
    const account = await callEnvelope(
      endpoints.account + encodeURIComponent(state),
      { method: 'GET', bearer: accessToken },
      endpoints,
      fetcher,
      signal,
    )
    const data = recordOf(account.data)
    uid = stringOf(data['uid'])
    const enterprise = stringOf(data['enterpriseId'])
    if (enterprise !== '') enterpriseId = enterprise
    const name = stringOf(data['nickname'])
    if (name !== '') nickname = name
  } catch (error: unknown) {
    if (error instanceof DeviceLoginError && error.code === 'aborted') throw error
    // Identity is display data here: a missing uid only means the card cannot
    // name the account, and the credential stays usable (uid is filled by the
    // first upstream answer that carries it).
  }

  // Region is a hard gate: sending one product's token to the other's endpoint
  // would leak it across products. The `domain` field is what reports it.
  const region = regionOf(domain)
  if (domain !== '' && region !== variant.region) {
    throw new DeviceLoginError(
      'region-mismatch',
      `the approved account belongs to ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'},`
      + ` but ${variant.displayName} was asked for; run login with --provider ${region === 'cn' ? 'workbuddy' : 'workbuddy-ai'}`,
    )
  }

  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken,
    expiresAtMs: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    domain,
    uid,
    source: 'dsh',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
  }
  return credential
}
