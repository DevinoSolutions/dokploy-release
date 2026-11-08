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
		const { status, json, headers } = handler(String(url), init, calls);
		return {
			status,
			headers: new Headers(headers ?? {}),
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
	assert.deepEqual(clock.sleeps, [5, 10, 20, 5]);
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
		return { status: 200, headers: new Headers(), body: null };
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
	assert.deepEqual(parseReadyOptions({}), { enabled: true, timeoutSeconds: 300, token: "" });
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
