#!/usr/bin/env node
import { C as WORKBUDDY_VARIANTS, L as regionOf, O as WorkBuddyUpstreamClient, Q as resolveAppVersion, S as CN_VARIANT, a as readHostHeartbeat, b as atRestKeyProviderFor, c as WORKBUDDY_CONNECT_VERSION, l as FALLBACK_WORKBUDDY_AI_MODELS, m as WorkBuddyCredentialStore, o as workbuddyHostHeartbeatPath, r as isHeartbeatProcessAlive, u as FALLBACK_WORKBUDDY_MODELS, w as variantFor } from "./host-heartbeat-BIW4dPFN.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/device-login.ts
/**
* Region table. Kept here rather than in `upstream.ts` because these are
* sign-in surfaces, not model surfaces: they answer the CLI client identity and
* carry no chat headers, so the two must not be conflated when either changes.
*/
const DEVICE_LOGIN_ENDPOINTS = {
	cn: {
		state: "https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI",
		token: "https://copilot.tencent.com/v2/plugin/auth/token?state=",
		account: "https://copilot.tencent.com/v2/plugin/login/account?state=",
		origin: "https://www.codebuddy.cn"
	},
	global: {
		state: "https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI",
		token: "https://www.workbuddy.ai/v2/plugin/auth/token?state=",
		account: "https://www.workbuddy.ai/v2/plugin/login/account?state=",
		origin: "https://www.workbuddy.ai"
	}
};
/** User-Agent of the official CLI, which these endpoints are written for. */
const CLI_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** Per-request HTTP bound; the whole flow is bounded separately. */
const REQUEST_TIMEOUT_MS = 3e4;
/** Typed failure of one device-login stage. */
var DeviceLoginError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "DeviceLoginError";
		this.code = code;
	}
};
function endpointsFor(variant) {
	return DEVICE_LOGIN_ENDPOINTS[variant.region];
}
function headersFor(endpoints, bearer) {
	const headers = {
		"Accept": "application/json, text/plain, */*",
		"Content-Type": "application/json",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": endpoints.origin,
		"Referer": `${endpoints.origin}/`,
		"User-Agent": CLI_UA
	};
	if (bearer !== void 0 && bearer !== "") headers["Authorization"] = `Bearer ${bearer}`;
	return headers;
}
function defaultSleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new DeviceLoginError("aborted", "device login cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new DeviceLoginError("aborted", "device login cancelled"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** One request, unwrapped to the `{code,msg,data}` envelope. Throws on transport failure. */
async function callEnvelope(url, init, endpoints, fetcher, signal) {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
	const response = await fetcher(url, {
		method: init.method,
		headers: headersFor(endpoints, init.bearer),
		...init.body === void 0 ? {} : { body: init.body },
		signal: combined
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new DeviceLoginError("incomplete", `sign-in endpoint answered HTTP ${response.status} with a non-JSON body`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DeviceLoginError("incomplete", `sign-in endpoint answered HTTP ${response.status} with an unexpected document`);
	return parsed;
}
function messageOf(envelope) {
	const msg = typeof envelope.msg === "string" ? envelope.msg.trim() : "";
	if (msg !== "") return `code=${String(envelope.code ?? "?")} msg=${msg}`;
	return `code=${String(envelope.code ?? "?")}`;
}
function recordOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function stringOf(value) {
	return typeof value === "string" ? value : "";
}
/**
* Mint a fresh authorization for one variant.
*
* The returned `authUrl` must be shown to the user; `state` is what
* {@link waitForDeviceLogin} polls with. Nothing is persisted here.
*/
async function startDeviceLogin(variant, options = {}) {
	const endpoints = endpointsFor(variant);
	const fetcher = options.fetcher ?? fetch;
	let envelope;
	try {
		envelope = await callEnvelope(endpoints.state, {
			method: "POST",
			body: "{}"
		}, endpoints, fetcher, options.signal);
	} catch (error) {
		if (error instanceof DeviceLoginError) {
			if (error.code === "aborted") throw error;
			throw new DeviceLoginError("state-failed", error.message);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new DeviceLoginError("state-failed", `could not reach the ${variant.displayName} sign-in service (${message})`);
	}
	if (envelope.code !== 0 && envelope.code !== void 0) throw new DeviceLoginError("state-failed", `sign-in service refused to start a login (${messageOf(envelope)})`);
	const data = recordOf(envelope.data);
	const state = stringOf(data["state"]);
	const authUrl = stringOf(data["authUrl"]);
	if (state === "" || authUrl === "") throw new DeviceLoginError("state-failed", "sign-in service answered without a state or an authorization URL");
	return {
		state,
		authUrl
	};
}
/**
* Poll until the user approves, then resolve the signed-in credential.
*
* A pending authorization is not an error upstream: the token endpoint answers
* a non-zero `code` until approval, so anything but a well-formed token answer
* is treated as "keep waiting" until {@link DeviceLoginOptions.timeoutMs}.
*/
async function waitForDeviceLogin(variant, state, options = {}) {
	const endpoints = endpointsFor(variant);
	const fetcher = options.fetcher ?? fetch;
	const timeoutMs = options.timeoutMs ?? 3e5;
	const pollMs = options.pollMs ?? 3e3;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const startedAt = now();
	let attempt = 0;
	for (;;) {
		attempt += 1;
		const envelope = await callEnvelope(endpoints.token + encodeURIComponent(state), { method: "GET" }, endpoints, fetcher, options.signal).catch((error) => {
			if (error instanceof DeviceLoginError && error.code === "aborted") throw error;
		});
		const data = recordOf(envelope?.data);
		const accessToken = stringOf(data["accessToken"]);
		if (envelope !== void 0 && (envelope.code === 0 || envelope.code === void 0) && accessToken !== "") return await finishLogin(variant, state, data, endpoints, fetcher, options.signal);
		const elapsedMs = now() - startedAt;
		if (elapsedMs >= timeoutMs) throw new DeviceLoginError("timeout", `authorization was not approved within ${Math.round(timeoutMs / 1e3)}s; run login again for a fresh link`);
		options.onPending?.(attempt, elapsedMs);
		await sleep(pollMs, options.signal);
	}
}
/** Turn the token answer plus the account answer into the plugin's credential shape. */
async function finishLogin(variant, state, tokenData, endpoints, fetcher, signal) {
	const accessToken = stringOf(tokenData["accessToken"]);
	const refreshToken = stringOf(tokenData["refreshToken"]);
	const expiresIn = typeof tokenData["expiresIn"] === "number" ? tokenData["expiresIn"] : 0;
	const domain = stringOf(tokenData["domain"]);
	let uid = "";
	let enterpriseId;
	let nickname;
	try {
		const data = recordOf((await callEnvelope(endpoints.account + encodeURIComponent(state), {
			method: "GET",
			bearer: accessToken
		}, endpoints, fetcher, signal)).data);
		uid = stringOf(data["uid"]);
		const enterprise = stringOf(data["enterpriseId"]);
		if (enterprise !== "") enterpriseId = enterprise;
		const name = stringOf(data["nickname"]);
		if (name !== "") nickname = name;
	} catch (error) {
		if (error instanceof DeviceLoginError && error.code === "aborted") throw error;
	}
	const region = regionOf(domain);
	if (domain !== "" && region !== variant.region) throw new DeviceLoginError("region-mismatch", `the approved account belongs to ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"}, but ${variant.displayName} was asked for; run login with --provider ${region === "cn" ? "workbuddy" : "workbuddy-ai"}`);
	return {
		accessToken,
		refreshToken,
		expiresAtMs: expiresIn > 0 ? Date.now() + expiresIn * 1e3 : 0,
		domain,
		uid,
		source: "dsh",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname }
	};
}
//#endregion
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy-connect <doctor|login|status|logout> [--provider <id>] [--json]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  login    sign in with a device code (no WorkBuddy desktop app required)",
		"  status   sign-in state, remaining WorkBuddy credit, and host-bundle health",
		"  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)",
		"",
		"  --provider  which product to inspect; defaults to workbuddy",
		`              one of: ${WORKBUDDY_VARIANTS.map((variant) => variant.id).join(", ")}`,
		"  --json      emit one secret-free JSON document (doctor/login/status)",
		"  --timeout   login only: seconds to wait for approval (default 300)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/**
* One variant's store plus the client that performs its refreshes.
*
* The key provider is built by the same shared helper the plugin host uses,
* so the CLI's `doctor`/`status` and the browser card can never disagree
* about which product's Electron a variant resolves.
*/
function makeStore(variant) {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({
		variant,
		refresh: (credential) => client.refreshToken(credential),
		keyProvider: atRestKeyProviderFor(variant)
	});
}
/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant) {
	return makeStore(variant).ownAuthPath();
}
/** Fallback roster size for one variant. */
function fallbackCount(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length;
}
async function doctor(jsonOutput, variant) {
	const store = makeStore(variant);
	const status = await store.status();
	const desktopPresent = await store.desktopFilePresent();
	const desktopFormat = await store.desktopAuthFormat();
	const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const appVersion = variant.region === "global" ? await resolveAppVersion() : void 0;
	const decryptionNote = status.state === "signed-out" && desktopFormat === "encrypted" && status.reason !== void 0 ? `Encrypted desktop credential could not be used: ${status.reason}` : void 0;
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy-connect",
		version: WORKBUDDY_CONNECT_VERSION,
		node: process.version,
		provider: variant.id,
		displayName: variant.displayName,
		desktopAuthFile: {
			path: desktopPath ?? `(no platform default; set ${variant.env})`,
			present: desktopPresent,
			format: desktopFormat
		},
		ownAuthFile: ownAuthPath(variant),
		...appVersion === void 0 ? {} : { catalogUserAgent: {
			version: appVersion.version,
			source: appVersion.source,
			...appVersion.bundle === void 0 ? {} : { bundle: appVersion.bundle }
		} },
		hostHeartbeat: {
			path: workbuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		fallbackModels: fallbackCount(variant),
		hints: [
			...decryptionNote !== void 0 ? [decryptionNote] : status.state === "signed-out" ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
			...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin."]
		]
	};
	if (jsonOutput) printJson({
		...report,
		...decryptionNote === void 0 ? {} : { decryptionNote }
	});
	else process.stdout.write([
		`${variant.displayName} Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} — ${desktopFormat} (${report.desktopAuthFile.path})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${report.signIn}`,
		`Static fallback models: ${report.fallbackModels}`,
		...appVersion === void 0 ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" && desktopPresent ? 0 : 1;
}
async function status(jsonOutput, variant) {
	const store = makeStore(variant);
	const client = new WorkBuddyUpstreamClient();
	const authStatus = await store.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	if (authStatus.state !== "signed-in") {
		if (jsonOutput) printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-out",
			hostBundle: hostState
		});
		else process.stdout.write(`${variant.displayName} Connect: signed out\nHost bundle: ${hostState}\n`);
		return 1;
	}
	let credits;
	try {
		const credential = await store.current();
		if (credential !== void 0) {
			const fetched = await client.fetchCredits(credential);
			credits = {
				total: fetched.total,
				...fetched.unlimited === true ? { unlimited: true } : {}
			};
		}
	} catch (error) {
		credits = {
			total: 0,
			error: safeMessage(error)
		};
	}
	const expiresAt = authStatus.expiresAtMs !== void 0 ? new Date(authStatus.expiresAtMs).toISOString() : void 0;
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
			...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
			source: authStatus.source,
			credits: credits?.total,
			...credits?.unlimited === true ? { creditsUnlimited: true } : {},
			...credits?.error === void 0 ? {} : { creditsError: credits.error },
			hostBundle: hostState
		});
		return 0;
	}
	process.stdout.write([
		`${variant.displayName} Connect: signed in${authStatus.nickname === void 0 ? "" : ` as ${authStatus.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		credits?.error !== void 0 ? `Remaining credit: unavailable (${credits.error})` : credits?.unlimited === true ? "Remaining credit: unlimited" : `Remaining credit: ${credits?.total ?? "unknown"}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host provider is unaffected.",
		""
	].join("\n"));
	return 0;
}
/**
* Device-code sign-in.
*
* This is the path for hosts that cannot reuse a desktop app's sign-in — a
* phone, a headless server, a container. The authorization URL is printed
* before any waiting starts, so a human (or a logging agent) can approve it
* from another device, and the credential lands in the plugin-owned copy that
* the host reads on its next request — no restart.
*/
async function login(jsonOutput, variant, timeoutSeconds) {
	const store = makeStore(variant);
	const timeoutMs = timeoutSeconds === void 0 ? void 0 : timeoutSeconds * 1e3;
	const session = await startDeviceLogin(variant, timeoutMs === void 0 ? {} : { timeoutMs });
	if (!jsonOutput) process.stdout.write([
		`${variant.displayName} Connect: device sign-in`,
		"Open this URL in any browser and approve it:",
		`  ${session.authUrl}`,
		"Waiting for approval… (Ctrl-C to cancel)",
		""
	].join("\n"));
	const credential = await waitForDeviceLogin(variant, session.state, {
		...timeoutMs === void 0 ? {} : { timeoutMs },
		...jsonOutput ? {} : { onPending: (attempt) => {
			process.stdout.write(attempt % 10 === 0 ? `\n  still waiting (${attempt * 3}s)` : ".");
		} }
	});
	const adopted = await store.adopt(credential);
	const expiresAt = adopted.expiresAtMs > 0 ? new Date(adopted.expiresAtMs).toISOString() : void 0;
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...adopted.nickname === void 0 ? {} : { nickname: adopted.nickname },
			...adopted.domain === "" ? {} : { domain: adopted.domain },
			credentialPath: store.ownAuthPath()
		});
		return 0;
	}
	process.stdout.write([
		"",
		`${variant.displayName} Connect: signed in${adopted.nickname === void 0 ? "" : ` as ${adopted.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		`Credential saved to ${store.ownAuthPath()}`,
		"The host reads it on the next request; no restart needed.",
		""
	].join("\n"));
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"doctor",
		"login",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy-connect: expected doctor, login, logout, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	let providerId;
	let timeoutSeconds;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		if (flag === "--timeout" || flag.startsWith("--timeout=")) {
			const value = flag === "--timeout" ? flags[index += 1] : flag.slice(10);
			const seconds = Number(value);
			if (action !== "login") {
				process.stderr.write("dsh-workbuddy-connect: --timeout is only valid for login\n");
				return 1;
			}
			if (!Number.isFinite(seconds) || seconds <= 0) {
				process.stderr.write(`dsh-workbuddy-connect: invalid --timeout ${JSON.stringify(value)}\n`);
				return 1;
			}
			timeoutSeconds = seconds;
			continue;
		}
		rest.push(flag);
	}
	const variant = providerId === void 0 ? CN_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	if (rest.filter((flag) => flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-workbuddy-connect: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput, variant);
			case "login": return await login(jsonOutput, variant, timeoutSeconds);
			case "status": return await status(jsonOutput, variant);
			case "logout": {
				const store = makeStore(variant);
				await store.logout();
				process.stdout.write(`${variant.displayName} Connect: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`);
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
