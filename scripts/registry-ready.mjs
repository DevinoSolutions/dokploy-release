// Registry readiness probe. A registry can lag behind the push that created a manifest: GHCR has answered
// `denied: denied` to an anonymous manifest GET 28 s after the push and served it 11 minutes later. Dokploy
// pulls the digest about 20 s after the release is published, so the release waits here until a
// HEAD of every released digest succeeds. No dependency: Node's built-in fetch.
//
//   parseReadyOptions(env)              reads the INPUT_REGISTRY_READY* variables
//   waitForRegistryReady({ refs, ... }) resolves when every ref is readable, throws RegistryNotReadyError on timeout
//
// Tokens are never logged: log lines only carry the image, what the registry answered and the next wait.

export class ReadyOptionError extends Error {}
export class RegistryNotReadyError extends Error {}

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 3600;
export const BACKOFF_SECONDS = [5, 10, 20, 30]; // then 30 s for every further attempt
const REQUEST_TIMEOUT_MS = 20_000;
const FIRST_REQUEST_MIN_MS = 3_000; // the first attempt always gets this long, even with registry-ready-timeout: 0
const HUB = "registry-1.docker.io";

export const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// docker.io, index.docker.io and registry-1.docker.io are one registry; the API host is registry-1.docker.io.
export const canonicalHost = (host) => {
	const lower = String(host).toLowerCase();
	return lower === "docker.io" || lower === "index.docker.io" ? HUB : lower;
};

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
	const tokenRegistry = canonicalHost(String(env.INPUT_REGISTRY_READY_TOKEN_REGISTRY ?? "").trim());
	if (tokenRegistry !== "" && token === "") {
		throw new ReadyOptionError("The input registry-ready-token-registry needs registry-ready-token");
	}
	return { enabled: flag !== "false", timeoutSeconds, token, tokenRegistry };
};

// <registry>/<repo>@sha256:<digest>. A ref without a registry host is Docker Hub shorthand. On Docker Hub a
// repository of one segment lives under library/.
export const splitRef = (ref) => {
	const at = ref.lastIndexOf("@");
	const name = ref.slice(0, at);
	const digest = ref.slice(at + 1);
	const slash = name.indexOf("/");
	const first = slash < 0 ? "" : name.slice(0, slash);
	const hasHost = first.includes(".") || first.includes(":") || first === "localhost";
	const host = hasHost ? canonicalHost(first) : HUB;
	let repo = hasHost ? name.slice(slash + 1) : name;
	if (host === HUB && !repo.includes("/")) repo = `library/${repo}`;
	return { host, repo, digest };
};

// The registry that receives registry-ready-token: the named one, else the only one in the release.
// Several registries and none named is refused before any request, so a credential never goes to the wrong host.
export const resolveTokenHost = ({ refs, token, tokenRegistry }) => {
	if (token === "") return "";
	const hosts = [...new Set(refs.map((ref) => splitRef(ref).host))];
	if (tokenRegistry !== "") {
		if (!hosts.includes(tokenRegistry)) {
			throw new ReadyOptionError(
				`registry-ready-token-registry names ${tokenRegistry}, which is none of the registries in this release (${hosts.join(", ")}).`,
			);
		}
		return tokenRegistry;
	}
	if (hosts.length === 1) return hosts[0];
	throw new ReadyOptionError(
		`registry-ready-token is set but this release has images on several registries (${hosts.join(", ")}); name the one it belongs to with registry-ready-token-registry.`,
	);
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

// Redirects are never followed: a registry that redirects a manifest HEAD is answering for something else
// (docker.io sends a browser to www.docker.com, which says 200 for any digest). A 3xx is "not ready".
// budget() is the time this request may take: never more than 20 s, never past the attempt's deadline.
const send = (fetchImpl, budget, url, init) =>
	fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(budget()) });

// One anonymous pull token for repo. Returns { token } (null when the registry does not challenge) or
// { detail } describing why no usable token came back.
const anonymousToken = async (fetchImpl, budget, host, repo) => {
	const scope = `repository:${repo}:pull`;
	let realm;
	let service = null;
	if (host === "ghcr.io") {
		realm = "https://ghcr.io/token";
	} else {
		const ping = await send(fetchImpl, budget, `${baseUrl(host)}/v2/`, { method: "GET" });
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
	const response = await send(fetchImpl, budget, url.toString(), { method: "GET" });
	if (response.status !== 200) {
		await response.body?.cancel?.().catch(() => {});
		return { detail: `token endpoint HTTP ${response.status}` };
	}
	const body = await response.json().catch(() => null);
	const token = body?.token ?? body?.access_token ?? null;
	return typeof token === "string" && token !== "" ? { token } : { detail: "token endpoint HTTP 200 without a token" };
};

// One probe: HEAD the manifest. Ready only on a 200 whose Docker-Content-Digest is the probed digest.
// Returns { ready, detail } where detail says what the registry answered.
export const probeOnce = async ({ fetchImpl, ref, token = "", budget = () => REQUEST_TIMEOUT_MS }) => {
	const { host, repo, digest } = splitRef(ref);
	let bearer = token || null;
	if (bearer === null) {
		const result = await anonymousToken(fetchImpl, budget, host, repo);
		if (result.detail !== undefined) return { ready: false, detail: result.detail };
		bearer = result.token;
	}
	const headers = { Accept: MANIFEST_ACCEPT };
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	const response = await send(fetchImpl, budget, `${baseUrl(host)}/v2/${repo}/manifests/${digest}`, {
		method: "HEAD",
		headers,
	});
	await response.body?.cancel?.().catch(() => {});
	if (response.status !== 200) return { ready: false, detail: `HTTP ${response.status}` };
	const served = response.headers.get("docker-content-digest");
	if (served === null || served === "") return { ready: false, detail: "HTTP 200 without Docker-Content-Digest" };
	if (served !== digest) {
		return { ready: false, detail: `HTTP 200 with Docker-Content-Digest ${served}, not ${digest}` };
	}
	return { ready: true, detail: "HTTP 200" };
};

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for one ref. now() and sleep() are injectable so tests run without waiting.
// No attempt starts at or after the deadline, and every request is bounded by the time that is left.
const waitForRef = async ({ fetchImpl, ref, token, timeoutSeconds, now, sleep, log }) => {
	const deadline = now() + timeoutSeconds * 1000;
	let attempt = 0;
	let last = "no answer";
	for (;;) {
		attempt += 1;
		const first = attempt === 1;
		const budget = () => Math.min(REQUEST_TIMEOUT_MS, Math.max(deadline - now(), first ? FIRST_REQUEST_MIN_MS : 1));
		try {
			const result = await probeOnce({ fetchImpl, ref, token, budget });
			if (result.ready) {
				log(`Registry ready: ${ref} is readable (attempt ${attempt}).`);
				return;
			}
			last = result.detail;
		} catch (error) {
			last = `network error (${error?.name ?? "Error"})`;
		}
		const remaining = deadline - now();
		const wanted = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)] * 1000;
		// The next attempt would start at or after the deadline: stop now instead of sleeping for nothing.
		if (wanted >= remaining) {
			throw new RegistryNotReadyError(
				`${ref} is not readable from the registry within ${timeoutSeconds} s (last answer: ${last}). ` +
					"Dokploy pulls this digest right after the release, so the release is refused. " +
					"For a private image set registry-ready: 'false' or pass registry-ready-token.",
			);
		}
		log(`Registry not ready yet: ${ref} answered ${last} (attempt ${attempt}); retrying in ${wanted / 1000} s.`);
		await sleep(wanted);
	}
};

export const waitForRegistryReady = async ({
	refs,
	token = "",
	tokenRegistry = "",
	timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
	fetchImpl = fetch,
	now = Date.now,
	sleep = realSleep,
	log = console.log,
}) => {
	const unique = [...new Set(refs)];
	const tokenHost = resolveTokenHost({ refs: unique, token, tokenRegistry });
	const results = await Promise.allSettled(
		unique.map((ref) =>
			waitForRef({
				fetchImpl,
				ref,
				token: tokenHost !== "" && splitRef(ref).host === tokenHost ? token : "",
				timeoutSeconds,
				now,
				sleep,
				log,
			}),
		),
	);
	const failed = results.filter((result) => result.status === "rejected");
	if (failed.length > 0) {
		throw new RegistryNotReadyError(failed.map((result) => result.reason?.message ?? String(result.reason)).join(" "));
	}
};
