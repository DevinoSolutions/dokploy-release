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
if (failed > 0) process.exit(1);
console.log(`${index.filter((e) => e.ok).length} valid fixtures follow the schema`);
