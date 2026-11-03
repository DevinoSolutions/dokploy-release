import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");
const D = (c) => `sha256:${c.repeat(64)}`;

const baseEnv = (dir, extra = {}) => ({
	PATH: process.env.PATH,
	SystemRoot: process.env.SystemRoot,
	RUNNER_TEMP: dir,
	GITHUB_OUTPUT: join(dir, "out.txt"),
	GITHUB_SHA: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	GITHUB_REF: "refs/heads/dev",
	GITHUB_RUN_ID: "123",
	GITHUB_RUN_ATTEMPT: "1",
	INPUT_ENVIRONMENT: "development",
	INPUT_SERVICE: "web",
	INPUT_EXISTING_IMAGE: `registry.devino.ca/voicelabs/web@${D("e")}`,
	...extra,
});

const withDir = (fn) => {
	const dir = mkdtempSync(join(tmpdir(), "dokploy-release-"));
	try {
		writeFileSync(join(dir, "out.txt"), "");
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("manifest writes the file and the outputs", () =>
	withDir((dir) => {
		const result = spawnSync("node", [cli, "manifest"], { env: baseEnv(dir), encoding: "utf8" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const manifest = JSON.parse(readFileSync(join(dir, "dokploy-release", "dokploy-release.json"), "utf8"));
		assert.equal(manifest.release.id, "gh-123.1");
		const out = readFileSync(join(dir, "out.txt"), "utf8");
		assert.match(out, /^path=.*dokploy-release\.json$/m);
		assert.match(out, /^release-id=gh-123\.1$/m);
		assert.match(out, /^published=true$/m);
	}));

test("a bad input fails the step when the release is pulled", () =>
	withDir((dir) => {
		const result = spawnSync("node", [cli, "manifest"], {
			env: baseEnv(dir, { INPUT_EXISTING_IMAGE: "ghcr.io/a/b/web:latest", INPUT_DELIVERY: "pull" }),
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stdout, /::error title=dokploy-release::/);
	}));

test("the same bad input only warns while the workflow still deploys by push", () =>
	withDir((dir) => {
		const result = spawnSync("node", [cli, "manifest"], {
			env: baseEnv(dir, { INPUT_EXISTING_IMAGE: "ghcr.io/a/b/web:latest", INPUT_DELIVERY: "push" }),
			encoding: "utf8",
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /::warning title=dokploy-release::/);
		assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /^published=false$/m);
	}));

test("deploy without a manifest file fails a pulled release and warns a pushed one", () =>
	withDir((dir) => {
		const pulled = spawnSync("node", [cli, "deploy"], { env: baseEnv(dir), encoding: "utf8" });
		assert.equal(pulled.status, 1);
		const pushed = spawnSync("node", [cli, "deploy"], {
			env: baseEnv(dir, { INPUT_DELIVERY: "push" }),
			encoding: "utf8",
		});
		assert.equal(pushed.status, 0);
	}));
