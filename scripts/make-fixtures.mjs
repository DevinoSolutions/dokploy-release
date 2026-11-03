// Writes fixtures/valid/*.json, fixtures/invalid/*.json and fixtures/index.json.
// Deterministic: running it twice changes nothing. The index is the contract
// test list: { file, ok, code } where code is the failure the Dokploy parser
// must report (valid files have none).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const d = (c) => `sha256:${c.repeat(64)}`;

export const base = () => ({
	schema: "dokploy.release/v1",
	sha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	delivery: "pull",
	release: { id: "gh-9876543210.1", services: ["web", "worker"] },
	source: {
		forge: "github",
		ref: "refs/heads/main",
		runId: "9876543210",
		runAttempt: 1,
	},
	environment: "production",
	services: [
		{
			key: "web",
			images: [
				{
					name: "web",
					composeService: "web",
					ref: `registry.example.com/acme/shop/web@${d("e")}`,
				},
			],
			compose: { path: "docker-compose.prod.yml" },
			migrations: null,
		},
		{
			key: "worker",
			images: [
				{
					name: "worker",
					composeService: "worker",
					ref: `registry.example.com/acme/shop/worker@${d("a")}`,
				},
			],
			migrations: null,
		},
	],
});

const mutate = (fn) => {
	const m = base();
	fn(m);
	return m;
};

const valid = {
	"multi-service-pull": base(),
	"single-service-push": mutate((m) => {
		m.delivery = "push";
		m.release.services = ["web"];
		m.services = [m.services[0]];
	}),
	"multi-image-compose": mutate((m) => {
		m.release.services = ["stack"];
		m.services = [
			{
				key: "stack",
				images: [
					{
						name: "web",
						composeService: "web",
						ref: `registry.devino.ca/shorty/web@${d("1")}`,
					},
					{
						name: "docs",
						composeService: "docs",
						ref: `registry.devino.ca/shorty/docs@${d("2")}`,
					},
				],
				compose: { path: "docker-compose.yml" },
				migrations: null,
			},
		];
	}),
	// The tunnel mirror's real names: the wrapper copies ghcr.io/<owner>/<repo>/<service> to
	// localhost:5000/registry.devino.ca/<repo>/<service> (host:port plus a path prefix).
	"tunnel-mirror": mutate((m) => {
		m.release.services = ["voicekit-web"];
		m.services = [
			{
				key: "voicekit-web",
				images: [
					{
						name: "web",
						composeService: "web",
						ref: `localhost:5000/registry.devino.ca/voicelabs/web@${d("3")}`,
					},
				],
				compose: { path: "docker-compose.prod.yml" },
				migrations: null,
			},
		];
	}),
	"minor-version-and-unknown-fields": mutate((m) => {
		m.schema = "dokploy.release/v1.2";
		m.futureField = { anything: true };
		m.services[0].extra = "ignored";
	}),
};

const invalid = {
	"not-an-object": [null, "invalid"],
	"unknown-major": [mutate((m) => (m.schema = "dokploy.release/v2")), "unknown-schema"],
	"no-schema": [mutate((m) => delete m.schema), "unknown-schema"],
	"short-sha": [mutate((m) => (m.sha = "3f9c2a1")), "invalid"],
	"uppercase-sha": [mutate((m) => (m.sha = m.sha.toUpperCase())), "invalid"],
	"bad-delivery": [mutate((m) => (m.delivery = "later")), "invalid"],
	"tag-instead-of-digest": [
		mutate((m) => (m.services[0].images[0].ref = "registry.example.com/acme/shop/web:latest")),
		"invalid",
	],
	"tag-next-to-digest": [
		mutate((m) => (m.services[0].images[0].ref = `registry.example.com/acme/shop/web:v1@${d("e")}`)),
		"invalid",
	],
	"tag-ref-source": [mutate((m) => (m.source.ref = "refs/tags/v1")), "invalid"],
	"run-attempt-zero": [mutate((m) => (m.source.runAttempt = 0)), "invalid"],
	"services-do-not-match-release": [
		mutate((m) => (m.release.services = ["web", "api"])),
		"invalid",
	],
	"duplicate-compose-service": [
		mutate((m) => m.services[0].images.push({ ...m.services[0].images[0] })),
		"invalid",
	],
	"compose-path-traversal": [
		mutate((m) => (m.services[0].compose.path = "../outside.yml")),
		"invalid",
	],
	"asks-for-migrations": [
		mutate((m) => (m.services[0].migrations = { command: "pnpm db:migrate", destructive: false })),
		"migrations-unsupported",
	],
};

rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "valid"), { recursive: true });
mkdirSync(join(root, "invalid"), { recursive: true });
const index = [];
for (const [name, body] of Object.entries(valid)) {
	writeFileSync(join(root, "valid", `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
	index.push({ file: `valid/${name}.json`, ok: true });
}
for (const [name, [body, code]] of Object.entries(invalid)) {
	writeFileSync(join(root, "invalid", `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
	index.push({ file: `invalid/${name}.json`, ok: false, code });
}
writeFileSync(join(root, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${index.length} fixtures`);
