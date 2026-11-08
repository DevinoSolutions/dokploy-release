// Registry readiness probe. A registry can lag behind the push that created a manifest: GHCR has answered
// `denied: denied` to an anonymous manifest GET 28 s after the push and served it 11 minutes later. Dokploy
// pulls the digest about 20 s after the release is published, so the release waits here until an
// anonymous (or token) HEAD of every released digest succeeds. No dependency: Node's built-in fetch.
//
//   parseReadyOptions(env)            reads INPUT_REGISTRY_READY, INPUT_REGISTRY_READY_TIMEOUT, INPUT_REGISTRY_READY_TOKEN
//   waitForRegistryReady({ refs, ... }) resolves when every ref answers 200, throws RegistryNotReadyError on timeout
//
// Tokens are never logged: log lines only carry the image, the HTTP status and the next wait.

export class ReadyOptionError extends Error {}
export class RegistryNotReadyError extends Error {}

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 3600;
export const BACKOFF_SECONDS = [5, 10, 20, 30]; // then 30 s for every further attempt
const REQUEST_TIMEOUT_MS = 20_000;

export const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export const parseReadyOptions = (env) => {
	const flag = String(env.INPUT_REGISTRY_READY ?? "").trim().toLowerCase();
	if (flag !== "" && flag !== "true" && flag !== "false") {
		throw new ReadyOptionError('The input registry-ready must be "true" or "false"');
	}
	const rawTimeout = String(env.INPUT_REGISTRY_READY_TIMEOUT ?? "").trim();
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	if (rawTimeout !== "") {
		if (!/^[0-9]{1,5}$/.test(rawTimeout) || Number(rawTimeout) > MAX_TIMEOUT_SECONDS) {
			throw new ReadyOptionError(
				`The input registry-ready-timeout must be a whole number of seconds from 0 to ${MAX_TIMEOUT_SECONDS}`,
			);
		}
		timeoutSeconds = Number(rawTimeout);
	}
	const token = String(env.INPUT_REGISTRY_READY_TOKEN ?? "").trim();
	return { enabled: flag !== "false", timeoutSeconds, token };
};

// <registry>/<repo>@sha256:<digest>. Refs in the manifest are already validated; a ref without a registry
// host (Docker Hub shorthand) is not something a pull by Dokploy would resolve either, so it is probed on Docker Hub.
export const splitRef = (ref) => {
	const at = ref.lastIndexOf("@");
	const name = ref.slice(0, at);
	const digest = ref.slice(at + 1);
	const slash = name.indexOf("/");
	const first = slash < 0 ? "" : name.slice(0, slash);
	const hasHost = first.includes(".") || first.includes(":") || first === "localhost";
	if (hasHost) return { host: first, repo: name.slice(slash + 1), digest };
	return { host: "registry-1.docker.io", repo: slash < 0 ? `library/${name}` : name, digest };
};

const baseUrl = (host) => {
	const local = host === "localhost" || host.startsWith("localhost:") || host.startsWith("127.0.0.1");
	return `${local ? "http" : "https"}://${host}`;
};

// Parses `Bearer realm="...",service="...",scope="..."`.
export const parseBearerChallenge = (header) => {
	const match = /^\s*bearer\s+(.*)$/i.exec(String(header ?? ""));
	if (!match) return null;
	const params = {};
	for (const part of match[1].matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) params[part[1].toLowerCase()] = part[2];
	return params.realm ? params : null;
};

const withTimeout = (fetchImpl, url, init) =>
	fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// One anonymous pull token for repo. Returns { token } (token may be null when the registry does not
// challenge) or { status } when the token endpoint itself refused.
const anonymousToken = async (fetchImpl, host, repo) => {
	const scope = `repository:${repo}:pull`;
	let realm;
	let service = null;
	if (host === "ghcr.io") {
		realm = "https://ghcr.io/token";
	} else {
		const ping = await withTimeout(fetchImpl, `${baseUrl(host)}/v2/`, { method: "GET" });
		await ping.body?.cancel?.().catch(() => {});
		if (ping.status !== 401) return { token: null };
		const challenge = parseBearerChallenge(ping.headers.get("www-authenticate"));
		if (challenge === null) return { token: null };
		realm = challenge.realm;
		service = challenge.service ?? null;
	}
	const url = new URL(realm);
	if (service) url.searchParams.set("service", service);
	url.searchParams.set("scope", scope);
	const response = await withTimeout(fetchImpl, url.toString(), { method: "GET" });
	if (response.status !== 200) {
		await response.body?.cancel?.().catch(() => {});
		return { status: response.status };
	}
	const body = await response.json().catch(() => null);
	const token = body?.token ?? body?.access_token ?? null;
	return token ? { token } : { status: response.status };
};

// One probe: HEAD the manifest. Returns the HTTP status that decided it (0 for a network error).
export const probeOnce = async ({ fetchImpl, ref, token }) => {
	const { host, repo, digest } = splitRef(ref);
	let bearer = token || null;
	if (bearer === null) {
		const result = await anonymousToken(fetchImpl, host, repo);
		if (result.status !== undefined) return result.status;
		bearer = result.token;
	}
	const headers = { Accept: MANIFEST_ACCEPT };
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	const response = await withTimeout(fetchImpl, `${baseUrl(host)}/v2/${repo}/manifests/${digest}`, {
		method: "HEAD",
		headers,
	});
	await response.body?.cancel?.().catch(() => {});
	return response.status;
};

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for one ref. now() and sleep() are injectable so tests run without waiting.
const waitForRef = async ({ fetchImpl, ref, token, timeoutSeconds, now, sleep, log }) => {
	const deadline = now() + timeoutSeconds * 1000;
	let attempt = 0;
	let last = "no answer";
	for (;;) {
		attempt += 1;
		let status = 0;
		try {
			status = await probeOnce({ fetchImpl, ref, token });
			last = status === 0 ? "no answer" : `HTTP ${status}`;
		} catch (error) {
			status = 0;
			last = `network error (${error?.name ?? "Error"})`;
		}
		if (status === 200) {
			log(`Registry ready: ${ref} is readable (attempt ${attempt}).`);
			return;
		}
		const remaining = deadline - now();
		if (remaining <= 0) {
			throw new RegistryNotReadyError(
				`${ref} is not readable from the registry after ${timeoutSeconds} s (last answer: ${last}). ` +
					"Dokploy pulls this digest right after the release, so the release is refused. " +
					"For a private image set registry-ready: 'false' or pass registry-ready-token.",
			);
		}
		const wanted = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)] * 1000;
		const wait = Math.min(wanted, remaining);
		log(`Registry not ready yet: ${ref} answered ${last} (attempt ${attempt}); retrying in ${Math.ceil(wait / 1000)} s.`);
		await sleep(wait);
	}
};

export const waitForRegistryReady = async ({
	refs,
	token = "",
	timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
	fetchImpl = fetch,
	now = Date.now,
	sleep = realSleep,
	log = console.log,
}) => {
	const unique = [...new Set(refs)];
	const results = await Promise.allSettled(
		unique.map((ref) => waitForRef({ fetchImpl, ref, token, timeoutSeconds, now, sleep, log })),
	);
	const failed = results.filter((result) => result.status === "rejected");
	if (failed.length > 0) {
		throw new RegistryNotReadyError(failed.map((result) => result.reason?.message ?? String(result.reason)).join(" "));
	}
};
