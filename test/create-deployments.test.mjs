import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeployments, DeploymentError, deploymentBody, WAKE_SCHEMA } from "../scripts/create-deployments.mjs";

const manifest = {
	sha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	environment: "production",
	release: { id: "gh-9876543210.2", services: ["web", "worker"] },
	source: { runId: "9876543210", runAttempt: 2 },
};

const reply = (status, json = {}, headers = {}) => ({
	status,
	headers: { get: (name) => headers[name.toLowerCase()] ?? null },
	json: async () => json,
	text: async () => JSON.stringify(json),
});

test("the Deployment is a wake-up record: the commit, a dokploy task, no waiting on checks", () => {
	assert.deepEqual(deploymentBody(manifest, "web"), {
		ref: manifest.sha,
		task: "dokploy:web",
		environment: "production",
		auto_merge: false,
		required_contexts: [],
		transient_environment: false,
		description: "Dokploy release gh-9876543210.2",
		payload: { schema: WAKE_SCHEMA, run_id: 9876543210, run_attempt: 2, artifact: "dokploy-release" },
	});
});

test("the payload carries the job and runner as hints, only when the environment has them", () => {
	const hinted = deploymentBody(manifest, "web", { GITHUB_JOB: "release", RUNNER_NAME: "GitHub Actions 7" });
	assert.equal(hinted.payload.job, "release");
	assert.equal(hinted.payload.runner, "GitHub Actions 7");
	assert.deepEqual(Object.keys(deploymentBody(manifest, "web", {}).payload), ["schema", "run_id", "run_attempt", "artifact"]);
	assert.equal(deploymentBody(manifest, "web", { GITHUB_JOB: "a\nb" }).payload.job, undefined);
});

test("the Deployment ref is a 40-character commit sha and the payload stays under 2 KiB", () => {
	const body = deploymentBody(manifest, "web");
	assert.match(body.ref, /^[0-9a-f]{40}$/);
	assert.ok(JSON.stringify(body.payload).length < 2048);
});

test("one Deployment per service, posted to the repository, with the token only in the header", async () => {
	const calls = [];
	const created = await createDeployments(
		{
			repository: "DevinoSolutions/voicelabs",
			token: "ghs_secret",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return reply(201, { id: 1000 + calls.length });
			},
		},
		manifest,
	);
	assert.deepEqual(created, [
		{ key: "web", id: 1001 },
		{ key: "worker", id: 1002 },
	]);
	assert.equal(calls[0].url, "https://api.github.com/repos/DevinoSolutions/voicelabs/deployments");
	assert.equal(calls[0].init.headers.Authorization, "Bearer ghs_secret");
	assert.equal(JSON.parse(calls[1].init.body).task, "dokploy:worker");
	assert.ok(!calls[0].init.body.includes("ghs_secret"));
});

test("a server error is retried, a client error is not", async () => {
	let n = 0;
	const created = await createDeployments(
		{
			repository: "a/b",
			token: "t",
			sleep: async () => {},
			fetch: async () => (++n < 3 ? reply(502) : reply(201, { id: 7 })),
		},
		{ ...manifest, release: { ...manifest.release, services: ["web"] } },
	);
	assert.equal(n, 3);
	assert.deepEqual(created, [{ key: "web", id: 7 }]);

	let calls = 0;
	await assert.rejects(
		createDeployments(
			{ repository: "a/b", token: "t", sleep: async () => {}, fetch: async () => (calls++, reply(422, { message: "bad ref" })) },
			{ ...manifest, release: { ...manifest.release, services: ["web"] } },
		),
		/Could not create the GitHub Deployment for web: HTTP 422/,
	);
	assert.equal(calls, 1);
});

test("a network failure ends in an error naming the service", async () => {
	await assert.rejects(
		createDeployments(
			{
				repository: "a/b",
				token: "t",
				sleep: async () => {},
				fetch: async () => {
					throw new Error("socket hang up");
				},
			},
			{ ...manifest, release: { ...manifest.release, services: ["web"] } },
		),
		/for web: socket hang up/,
	);
});

test("a repository that is not owner/name is refused before any request", async () => {
	await assert.rejects(
		createDeployments({ repository: "../x", token: "t", fetch: async () => assert.fail("no request") }, manifest),
		/owner\/name/,
	);
});

const one = { ...manifest, release: { ...manifest.release, services: ["web"] } };

test("a 429 waits as long as Retry-After says, and a 403 with Retry-After is retried too", async () => {
	const waits = [];
	let n = 0;
	const created = await createDeployments(
		{
			repository: "a/b",
			token: "t",
			sleep: async (ms) => waits.push(ms),
			fetch: async () => {
				n += 1;
				if (n === 1) return reply(429, {}, { "retry-after": "7" });
				if (n === 2) return reply(403, { message: "secondary rate limit" }, { "retry-after": "2" });
				return reply(201, { id: 9 });
			},
		},
		one,
	);
	assert.deepEqual(waits, [7000, 2000]);
	assert.deepEqual(created, [{ key: "web", id: 9 }]);
});

test("a Retry-After far in the future is capped", async () => {
	const waits = [];
	let n = 0;
	await createDeployments(
		{
			repository: "a/b",
			token: "t",
			sleep: async (ms) => waits.push(ms),
			fetch: async () => (++n < 2 ? reply(429, {}, { "retry-after": "3600" }) : reply(201, { id: 1 })),
		},
		one,
	);
	assert.deepEqual(waits, [60000]);
});

test("a plain 403 (no Retry-After) is not retried", async () => {
	let n = 0;
	await assert.rejects(
		createDeployments(
			{ repository: "a/b", token: "t", sleep: async () => {}, fetch: async () => (n++, reply(403, { message: "forbidden" })) },
			one,
		),
		(error) => error instanceof DeploymentError && /HTTP 403/.test(error.message),
	);
	assert.equal(n, 1);
});
