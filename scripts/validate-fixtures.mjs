// CI only: every valid fixture follows the JSON schema. (The invalid ones
// break rules a schema cannot state, so they are checked by Dokploy's parser,
// whose tests read the same files.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "schema", "dokploy.release.v1.schema.json"), "utf8"));
const index = JSON.parse(readFileSync(join(root, "fixtures", "index.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

let failed = 0;
for (const entry of index.filter((e) => e.ok)) {
	const body = JSON.parse(readFileSync(join(root, "fixtures", entry.file), "utf8"));
	if (!validate(body)) {
		failed += 1;
		console.error(`${entry.file} does not follow the schema:`, JSON.stringify(validate.errors));
	}
}

// Rules the schema does state, checked on small edits of a valid fixture.
const sample = () => JSON.parse(readFileSync(join(root, "fixtures", "valid", "multi-service-pull.json"), "utf8"));
const digest = `@sha256:${"e".repeat(64)}`;
const edits = [
	["a tag next to a digest", false, (m) => (m.services[0].images[0].ref = `registry.example.com/acme/shop/web:v1${digest}`)],
	["an uppercase image name", false, (m) => (m.services[0].images[0].ref = `Registry.Example.com/acme/shop/web${digest}`)],
	["a compose path that leaves the repository", false, (m) => (m.services[0].compose.path = "../outside.yml")],
	["a compose path with a nested .. segment", false, (m) => (m.services[0].compose.path = "a/../b.yml")],
	["two dots inside a compose file name", true, (m) => (m.services[0].compose.path = "docker..compose.yml")],
];
for (const [what, ok, edit] of edits) {
	const manifest = sample();
	edit(manifest);
	if (validate(manifest) !== ok) {
		failed += 1;
		console.error(`the schema should ${ok ? "accept" : "refuse"} ${what}`);
	}
}
if (failed > 0) process.exit(1);
console.log(`${index.filter((e) => e.ok).length} valid fixtures follow the schema`);
