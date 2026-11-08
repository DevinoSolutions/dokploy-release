import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseBearerChallenge,
	parseReadyOptions,
	ReadyOptionError,
	RegistryNotReadyError,
	splitRef,
	waitForRegistryReady,
} from "../scripts/registry-ready.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const GHCR = `ghcr.io/acme/shop@${DIGEST}`;
const SECRET = "s3cr3t-token-value";

// A scripted registry: handler(url, init) returns { status, json?, headers? }. Every call is recorded.
const makeFetch = (handler) => {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url: String(url), method: init.method, headers: init.headers ?? {} });
		calls[calls.length - 1].redirect = init.redirect;
		const { status, json, headers } = handler(String(url), init, calls);
		const out = { ...(headers ?? {}) };
		// A registry that serves a manifest says which digest it is (Docker-Content-Digest); an empty value leaves the header out.
		const manifest = String(url).match(/\/manifests\/(sha256:[0-9a-f]{64})$/);
		if (status === 200 && manifest && !("docker-content-digest" in out)) out["docker-content-digest"] = manifest[1];
		if (out["docker-content-digest"] === "") delete out["docker-content-digest"];
		return {
			status,
			headers: new Headers(out),
			json: async () => json,
			body: null,
		};
	};
	return { fetchImpl, calls };
};

// A fake clock: sleep advances it, so the tests never wait.
const makeClock = () => {
	let time = 0;
	const sleeps = [];
	return {
		now: () => time,
		sleep: async (ms) => {
			sleeps.push(ms / 1000);
			time += ms;
		},
		sleeps,
	};
};

const ghcrHandler = (manifestStatuses) => {
	let n = 0;
	return (url) => {
		if (url.startsWith("https://ghcr.io/token")) return { status: 200, json: { token: SECRET } };
		const status = manifestStatuses[Math.min(n, manifestStatuses.length - 1)];
		n += 1;
		return { status };
	};
};

const run = (extra) => {
	const logs = [];
	const clock = makeClock();
	return {
		logs,
		clock,
		promise: waitForRegistryReady({ now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line), ...extra }),
	};
};

test("ready on the first try: one token request, one HEAD with the accept headers and the bearer token", async () => {
	const { fetchImpl, calls } = makeFetch(ghcrHandler([200]));
	const { promise, clock, logs } = run({ refs: [GHCR], fetchImpl });
	await promise;
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://ghcr.io/token?scope=repository%3Aacme%2Fshop%3Apull");
	assert.equal(calls[1].method, "HEAD");
	assert.equal(calls[0].redirect, "manual");
	assert.equal(calls[1].redirect, "manual");
	assert.equal(calls[1].url, `https://ghcr.io/v2/acme/shop/manifests/${DIGEST}`);
	assert.equal(calls[1].headers.Authorization, `Bearer ${SECRET}`);
	for (const type of [
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	]) {
		assert.ok(calls[1].headers.Accept.includes(type), type);
	}
	assert.deepEqual(clock.sleeps, []);
	assert.equal(logs.length, 1);
	assert.ok(!logs.join("\n").includes(SECRET));
});

test("ready after two 403s: backs off 5 s then 10 s and logs each attempt without the token", async () => {
	const { fetchImpl } = makeFetch(ghcrHandler([403, 403, 200]));
	const { promise, clock, logs } = run({ refs: [GHCR], fetchImpl });
	await promise;
	assert.deepEqual(clock.sleeps, [5, 10]);
	assert.equal(logs.length, 3);
	assert.match(logs[0], /HTTP 403.*attempt 1.*retrying in 5 s/);
	assert.match(logs[1], /HTTP 403.*attempt 2.*retrying in 10 s/);
	assert.match(logs[2], /Registry ready/);
	assert.ok(!logs.join("\n").includes(SECRET));
});

test("401 and 404 are also not-yet; the backoff is 5, 10, 20, 30, 30", async () => {
	const { fetchImpl } = makeFetch(ghcrHandler([401, 404, 403, 401, 404, 200]));
	const { promise, clock } = run({ refs: [GHCR], fetchImpl });
	await promise;
	assert.deepEqual(clock.sleeps, [5, 10, 20, 30, 30]);
});

test("timeout: fails naming the image and the last status, last wait is clamped to the cap", async () => {
	const { fetchImpl } = makeFetch(ghcrHandler([403]));
	const { promise, clock } = run({ refs: [GHCR], fetchImpl, timeoutSeconds: 40 });
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof RegistryNotReadyError);
		assert.ok(error.message.includes(GHCR));
		assert.match(error.message, /HTTP 403/);
		assert.match(error.message, /40 s/);
		assert.ok(!error.message.includes(SECRET));
		return true;
	});
	assert.deepEqual(clock.sleeps, [5, 10, 20]); // the next attempt would start past the 40 s cap
});

test("timeout 0 tries once", async () => {
	const { fetchImpl, calls } = makeFetch(ghcrHandler([404]));
	const { promise } = run({ refs: [GHCR], fetchImpl, timeoutSeconds: 0 });
	await assert.rejects(promise, /HTTP 404/);
	assert.equal(calls.length, 2);
});

test("a network error is retried and reported", async () => {
	let n = 0;
	const fetchImpl = async (url) => {
		if (url.startsWith("https://ghcr.io/token")) {
			return { status: 200, headers: new Headers(), json: async () => ({ token: SECRET }), body: null };
		}
		n += 1;
		if (n === 1) throw new TypeError("fetch failed");
		return { status: 200, headers: new Headers({ "docker-content-digest": DIGEST }), body: null };
	};
	const { promise, logs } = run({ refs: [GHCR], fetchImpl });
	await promise;
	assert.match(logs[0], /network error \(TypeError\)/);
});

test("registry-ready-token: sent as the bearer token and no token request is made", async () => {
	const { fetchImpl, calls } = makeFetch(() => ({ status: 200 }));
	const { promise, logs } = run({ refs: [`registry.example.com/team/app@${DIGEST}`], fetchImpl, token: SECRET });
	await promise;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, "HEAD");
	assert.equal(calls[0].url, `https://registry.example.com/v2/team/app/manifests/${DIGEST}`);
	assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
	assert.ok(!logs.join("\n").includes(SECRET));
});

test("a registry that challenges with Bearer: the token comes from the challenge realm and service", async () => {
	const ref = `registry.example.com/team/app@${DIGEST}`;
	const { fetchImpl, calls } = makeFetch((url) => {
		if (url === "https://registry.example.com/v2/") {
			return {
				status: 401,
				headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="registry.example.com"' },
			};
		}
		if (url.startsWith("https://auth.example.com/token")) return { status: 200, json: { access_token: SECRET } };
		return { status: 200 };
	});
	const { promise } = run({ refs: [ref], fetchImpl });
	await promise;
	assert.equal(calls.length, 3);
	const tokenUrl = new URL(calls[1].url);
	assert.equal(tokenUrl.searchParams.get("service"), "registry.example.com");
	assert.equal(tokenUrl.searchParams.get("scope"), "repository:team/app:pull");
	assert.equal(calls[2].headers.Authorization, `Bearer ${SECRET}`);
});

test("a registry without a Bearer challenge: HEAD without authorization", async () => {
	const ref = `registry.example.com/team/app@${DIGEST}`;
	for (const ping of [{ status: 200 }, { status: 401, headers: { "www-authenticate": 'Basic realm="x"' } }]) {
		const { fetchImpl, calls } = makeFetch((url) => (url.endsWith("/v2/") ? ping : { status: 200 }));
		const { promise } = run({ refs: [ref], fetchImpl });
		await promise;
		assert.equal(calls.length, 2);
		assert.equal(calls[1].method, "HEAD");
		assert.equal(calls[1].headers.Authorization, undefined);
	}
});

test("a token endpoint that refuses is retried like a manifest 403", async () => {
	let n = 0;
	const { fetchImpl } = makeFetch((url) => {
		if (url.startsWith("https://ghcr.io/token")) {
			n += 1;
			return n === 1 ? { status: 503 } : { status: 200, json: { token: SECRET } };
		}
		return { status: 200 };
	});
	const { promise, logs } = run({ refs: [GHCR], fetchImpl });
	await promise;
	assert.match(logs[0], /HTTP 503/);
});

test("several images each have their own wait; one never ready fails the whole probe", async () => {
	const other = `ghcr.io/acme/worker@sha256:${"b".repeat(64)}`;
	const { fetchImpl } = makeFetch((url) => {
		if (url.startsWith("https://ghcr.io/token")) return { status: 200, json: { token: SECRET } };
		return { status: url.includes("/worker/") ? 404 : 200 };
	});
	const { promise } = run({ refs: [GHCR, other, GHCR], fetchImpl, timeoutSeconds: 10 });
	await assert.rejects(promise, (error) => {
		assert.ok(error.message.includes(other));
		assert.ok(!error.message.includes("acme/shop"));
		return true;
	});
});

test("parseReadyOptions: defaults, off switch, bad values", () => {
	assert.deepEqual(parseReadyOptions({}), { enabled: true, timeoutSeconds: 300, token: "", tokenRegistry: "" });
	assert.equal(parseReadyOptions({ INPUT_REGISTRY_READY: "false" }).enabled, false);
	assert.equal(parseReadyOptions({ INPUT_REGISTRY_READY: "TRUE" }).enabled, true);
	assert.equal(parseReadyOptions({ INPUT_REGISTRY_READY_TIMEOUT: "90" }).timeoutSeconds, 90);
	assert.equal(parseReadyOptions({ INPUT_REGISTRY_READY_TIMEOUT: "0" }).timeoutSeconds, 0);
	assert.equal(parseReadyOptions({ INPUT_REGISTRY_READY_TOKEN: ` ${SECRET} ` }).token, SECRET);
	assert.throws(() => parseReadyOptions({ INPUT_REGISTRY_READY: "yes" }), ReadyOptionError);
	assert.throws(() => parseReadyOptions({ INPUT_REGISTRY_READY_TIMEOUT: "-1" }), ReadyOptionError);
	assert.throws(() => parseReadyOptions({ INPUT_REGISTRY_READY_TIMEOUT: "abc" }), ReadyOptionError);
	assert.throws(() => parseReadyOptions({ INPUT_REGISTRY_READY_TIMEOUT: "99999" }), ReadyOptionError);
});

test("splitRef and parseBearerChallenge", () => {
	assert.deepEqual(splitRef(GHCR), { host: "ghcr.io", repo: "acme/shop", digest: DIGEST });
	assert.deepEqual(splitRef(`registry.devino.ca:5000/a/b/c@${DIGEST}`), {
		host: "registry.devino.ca:5000",
		repo: "a/b/c",
		digest: DIGEST,
	});
	assert.deepEqual(splitRef(`acme/shop@${DIGEST}`), { host: "registry-1.docker.io", repo: "acme/shop", digest: DIGEST });
	assert.deepEqual(splitRef(`nginx@${DIGEST}`), { host: "registry-1.docker.io", repo: "library/nginx", digest: DIGEST });
	assert.deepEqual(parseBearerChallenge('Bearer realm="https://a/t",service="s"'), { realm: "https://a/t", service: "s" });
	assert.equal(parseBearerChallenge('Basic realm="x"'), null);
	assert.equal(parseBearerChallenge(null), null);
});

test("docker.io refs are probed on registry-1.docker.io with the library/ prefix", async () => {
	for (const [ref, repo] of [
		[`docker.io/nginx@${DIGEST}`, "library/nginx"],
		[`docker.io/library/nginx@${DIGEST}`, "library/nginx"],
		[`index.docker.io/acme/shop@${DIGEST}`, "acme/shop"],
		[`nginx@${DIGEST}`, "library/nginx"],
	]) {
		const { fetchImpl, calls } = makeFetch((url) => {
			if (url === "https://registry-1.docker.io/v2/") {
				return {
					status: 401,
					headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
				};
			}
			if (url.startsWith("https://auth.docker.io/token")) return { status: 200, json: { token: SECRET } };
			return { status: 200 };
		});
		const { promise } = run({ refs: [ref], fetchImpl });
		await promise;
		assert.equal(calls[0].url, "https://registry-1.docker.io/v2/", ref);
		assert.equal(new URL(calls[1].url).searchParams.get("scope"), `repository:${repo}:pull`, ref);
		assert.equal(calls[2].url, `https://registry-1.docker.io/v2/${repo}/manifests/${DIGEST}`, ref);
	}
	assert.deepEqual(splitRef(`docker.io/nginx@${DIGEST}`), {
		host: "registry-1.docker.io",
		repo: "library/nginx",
		digest: DIGEST,
	});
});

test("a redirect is not followed and counts as not ready", async () => {
	const { fetchImpl } = makeFetch(ghcrHandler([302, 200]));
	const { promise, logs } = run({ refs: [GHCR], fetchImpl });
	await promise;
	assert.match(logs[0], /HTTP 302/);
});

test("a 200 without a Docker-Content-Digest header, or with another digest, is not ready", async () => {
	const other = `sha256:${"c".repeat(64)}`;
	for (const [bad, pattern] of [
		["", /without Docker-Content-Digest/],
		[other, /Docker-Content-Digest sha256:c+, not sha256:a+/],
	]) {
		const { fetchImpl } = makeFetch((url) =>
			url.startsWith("https://ghcr.io/token")
				? { status: 200, json: { token: SECRET } }
				: { status: 200, headers: { "docker-content-digest": bad } },
		);
		const { promise } = run({ refs: [GHCR], fetchImpl, timeoutSeconds: 10 });
		await assert.rejects(promise, (error) => {
			assert.match(error.message, pattern);
			assert.ok(error.message.includes(GHCR));
			return true;
		});
	}
});

test("a token endpoint that answers 200 without a token is a failed attempt and sends no manifest request", async () => {
	for (const json of [{}, { token: "" }, null]) {
		let n = 0;
		const { fetchImpl, calls } = makeFetch((url) => {
			if (url.startsWith("https://ghcr.io/token")) {
				n += 1;
				return n === 1 ? { status: 200, json } : { status: 200, json: { token: SECRET } };
			}
			return { status: 200 };
		});
		const { promise, logs } = run({ refs: [GHCR], fetchImpl });
		await promise;
		assert.match(logs[0], /token endpoint HTTP 200 without a token/);
		assert.equal(calls.filter((call) => call.method === "HEAD").length, 1);
	}
});

test("registry-ready-token goes only to the named registry", async () => {
	const other = `registry.example.com/team/app@${DIGEST}`;
	const { fetchImpl, calls } = makeFetch((url) =>
		url.startsWith("https://ghcr.io/token") ? { status: 200, json: { token: "anon-ghcr" } } : { status: 200 },
	);
	const { promise } = run({ refs: [GHCR, other], fetchImpl, token: SECRET, tokenRegistry: "registry.example.com" });
	await promise;
	const heads = calls.filter((call) => call.method === "HEAD");
	assert.equal(heads.find((call) => call.url.startsWith("https://ghcr.io")).headers.Authorization, "Bearer anon-ghcr");
	assert.equal(
		heads.find((call) => call.url.startsWith("https://registry.example.com")).headers.Authorization,
		`Bearer ${SECRET}`,
	);
	assert.ok(!calls.some((call) => call.url.startsWith("https://ghcr.io") && JSON.stringify(call.headers).includes(SECRET)));
});

test("registry-ready-token without a named registry: used on the only registry, refused before any request with several", async () => {
	const { fetchImpl, calls } = makeFetch(() => ({ status: 200 }));
	const one = run({ refs: [`registry.example.com/a@${DIGEST}`], fetchImpl, token: SECRET });
	await one.promise;
	assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);

	calls.length = 0;
	const many = run({ refs: [GHCR, `registry.example.com/a@${DIGEST}`], fetchImpl, token: SECRET });
	await assert.rejects(many.promise, (error) => {
		assert.ok(error instanceof ReadyOptionError);
		assert.match(error.message, /several registries.*ghcr.io.*registry.example.com.*registry-ready-token-registry/);
		assert.ok(!error.message.includes(SECRET));
		return true;
	});
	assert.equal(calls.length, 0);

	const wrong = run({ refs: [GHCR], fetchImpl, token: SECRET, tokenRegistry: "nowhere.example.com" });
	await assert.rejects(wrong.promise, ReadyOptionError);
	assert.equal(calls.length, 0);
});

test("the token registry input is normalised and needs a token", () => {
	const env = { INPUT_REGISTRY_READY_TOKEN: "t", INPUT_REGISTRY_READY_TOKEN_REGISTRY: "Docker.io" };
	assert.equal(parseReadyOptions(env).tokenRegistry, "registry-1.docker.io");
	assert.throws(() => parseReadyOptions({ INPUT_REGISTRY_READY_TOKEN_REGISTRY: "ghcr.io" }), ReadyOptionError);
});

test("slow requests: every request gets an abort signal and no attempt starts past the deadline", async () => {
	let time = 0;
	let signals = 0;
	const fetchImpl = async (url, init) => {
		if (init.signal instanceof AbortSignal) signals += 1;
		time += 15_000; // a slow registry: every request takes 15 s
		return { status: 403, headers: new Headers(), body: null, json: async () => ({ token: SECRET }) };
	};
	await assert.rejects(
		waitForRegistryReady({
			refs: [GHCR],
			fetchImpl,
			timeoutSeconds: 40,
			now: () => time,
			sleep: async (ms) => {
				time += ms;
			},
			log: () => {},
		}),
		RegistryNotReadyError,
	);
	assert.ok(signals >= 2);
	assert.ok(time < 40_000 + 30_000, `ran until ${time} ms`);
});
