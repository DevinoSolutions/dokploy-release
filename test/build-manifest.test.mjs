import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildManifest, InputError } from "../scripts/build-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, "..", "fixtures", name), "utf8"));
const D = (c) => `sha256:${c.repeat(64)}`;

const run = {
	GITHUB_SHA: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	GITHUB_REF: "refs/heads/main",
	GITHUB_RUN_ID: "9876543210",
	GITHUB_RUN_ATTEMPT: "1",
};
const env = (extra) => ({ INPUT_ENVIRONMENT: "production", INPUT_DELIVERY: "pull", ...run, ...extra });
const refuses = (extra, pattern) =>
	assert.throws(() => buildManifest(env(extra)), (error) => error instanceof InputError && pattern.test(error.message));

test("a compose with two images equals the golden fixture", () => {
	const manifest = buildManifest(
		env({
			INPUT_SERVICE: "stack",
			INPUT_COMPOSE: "docker-compose.yml",
			INPUT_EXISTING_IMAGE: [
				`stack/web=registry.devino.ca/shorty/web@${D("1")}`,
				`stack/docs=registry.devino.ca/shorty/docs@${D("2")}`,
			].join("\n"),
		}),
	);
	assert.deepEqual(manifest, fixture("valid/multi-image-compose.json"));
});

test("a bare image belongs to the only service", () => {
	const manifest = buildManifest(
		env({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/acme/shop/web@${D("e")}` }),
	);
	assert.deepEqual(manifest.services, [
		{
			key: "web",
			images: [{ name: "web", composeService: "web", ref: `ghcr.io/acme/shop/web@${D("e")}` }],
			migrations: null,
		},
	]);
	assert.equal(manifest.release.id, "gh-9876543210.1");
	assert.equal(manifest.source.runAttempt, 1);
});

test("several services each get their own image, from services and service", () => {
	const manifest = buildManifest(
		env({
			INPUT_SERVICES: "web\nworker",
			INPUT_EXISTING_IMAGE: `web=reg.example.com/a/web@${D("a")}\nworker=reg.example.com/a/worker@${D("b")}`,
		}),
	);
	assert.deepEqual(manifest.release.services, ["web", "worker"]);
	assert.equal(manifest.services[1].images[0].ref, `reg.example.com/a/worker@${D("b")}`);
	assert.equal(manifest.delivery, "pull");
});

test("push delivery is carried into the manifest", () => {
	const manifest = buildManifest(
		env({ INPUT_DELIVERY: "push", INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }),
	);
	assert.equal(manifest.delivery, "push");
});

test("a tag is refused, with and without a digest next to it", () => {
	refuses({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: "ghcr.io/a/b/web:latest" }, /not\. A tag is refused/);
	refuses({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web:v1@${D("e")}` }, /is not/);
});

test("with several services every line names its service", () => {
	refuses({ INPUT_SERVICES: "web\nworker", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /<key>=<image>/);
});

test("a service without an image, an unknown service and a repeated image are refused", () => {
	refuses({ INPUT_SERVICES: "web\nworker", INPUT_EXISTING_IMAGE: `web=ghcr.io/a/b/web@${D("e")}` }, /worker has no image/);
	refuses({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `api=ghcr.io/a/b/api@${D("e")}` }, /not one of the services/);
	refuses(
		{ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `web=ghcr.io/a/b/web@${D("e")}\nweb=ghcr.io/a/b/web@${D("f")}` },
		/two images/,
	);
});

test("odd inputs are refused", () => {
	refuses({ INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /Name the service/);
	refuses({ INPUT_SERVICE: "Web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /lowercase/);
	refuses({ INPUT_SERVICES: "web\nweb", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /twice/);
	refuses({ INPUT_SERVICE: "web", INPUT_DELIVERY: "later", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /pull" or "push/);
	refuses({ INPUT_SERVICE: "web", INPUT_ENVIRONMENT: " ", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /environment is required/);
	refuses({ INPUT_SERVICE: "web", INPUT_COMPOSE: "../x.yml", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /relative path/);
});

test("build inputs are refused until a later version builds", () => {
	for (const name of ["IMAGE", "DOCKERFILE", "CONTEXT", "BUILDER", "REGISTRY"]) {
		refuses({ INPUT_SERVICE: "web", [`INPUT_${name}`]: "x", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /later version/);
	}
});

test("a run that is not on a branch cannot release", () => {
	refuses(
		{ GITHUB_REF: "refs/tags/v1", INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` },
		/from a branch/,
	);
	refuses(
		{ GITHUB_REF: "refs/pull/3/merge", INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` },
		/from a branch/,
	);
});

test("comments and blank lines in existing-image are ignored", () => {
	const manifest = buildManifest(
		env({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `# built by the build job\n\n ghcr.io/a/b/web@${D("e")} \n` }),
	);
	assert.equal(manifest.services[0].images.length, 1);
});
