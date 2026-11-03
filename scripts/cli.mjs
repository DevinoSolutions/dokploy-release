// Entry points of action.yml.
//   node cli.mjs manifest   writes $RUNNER_TEMP/dokploy-release/dokploy-release.json and the step outputs
//   node cli.mjs deploy     reads that file and creates the GitHub Deployments
// A failure fails the step, except with delivery "push": there the workflow
// already deploys by itself, so publishing is best effort and only warns.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, InputError } from "./build-manifest.mjs";
import { createDeployments } from "./create-deployments.mjs";

const command = process.argv[2];
const dir = join(process.env.RUNNER_TEMP ?? ".", "dokploy-release");
const file = join(dir, "dokploy-release.json");

const output = (name, value) => {
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	}
};

const fail = (message, delivery) => {
	const line = String(message).replace(/[\r\n]+/g, " ");
	if (delivery === "push") {
		console.log(`::warning title=dokploy-release::${line} The workflow's own deploy is not affected.`);
		output("published", "false");
		process.exit(0);
	}
	console.log(`::error title=dokploy-release::${line}`);
	process.exit(1);
};

const delivery = String(process.env.INPUT_DELIVERY ?? "pull").trim() || "pull";

if (command === "manifest") {
	try {
		const manifest = buildManifest(process.env);
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
		output("path", file);
		output("release-id", manifest.release.id);
		output("published", "true");
		console.log(`Release ${manifest.release.id}: ${manifest.release.services.join(", ")} (${manifest.delivery})`);
	} catch (error) {
		fail(error instanceof InputError ? error.message : `Unexpected error: ${error}`, delivery);
	}
} else if (command === "deploy") {
	try {
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		const created = await createDeployments(
			{
				fetch,
				token: process.env.GITHUB_TOKEN ?? "",
				repository: process.env.GITHUB_REPOSITORY ?? "",
				apiUrl: process.env.GITHUB_API_URL,
			},
			manifest,
		);
		for (const { key, id } of created) console.log(`GitHub Deployment ${id} for ${key}`);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), delivery);
	}
} else {
	console.log("::error title=dokploy-release::usage: cli.mjs manifest|deploy");
	process.exit(2);
}
