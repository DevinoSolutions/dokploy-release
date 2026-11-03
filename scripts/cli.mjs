// Entry points of action.yml.
//   node cli.mjs manifest   writes $RUNNER_TEMP/dokploy-release/dokploy-release.json and the step outputs
//   node cli.mjs deploy     reads that file and creates the GitHub Deployments
// A bad input or configuration fails the step in both delivery modes. Only a
// network or API failure of the GitHub Deployment call is best effort with
// delivery "push" (the workflow already deploys by itself): it warns and exits 0.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, InputError } from "./build-manifest.mjs";
import { createDeployments, DeploymentError } from "./create-deployments.mjs";

const command = process.argv[2];
const dir = join(process.env.RUNNER_TEMP ?? ".", "dokploy-release");
const file = join(dir, "dokploy-release.json");

const output = (name, value) => {
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	}
};

const oneLine = (message) => String(message).replace(/[\r\n]+/g, " ");

const fail = (message) => {
	console.log(`::error title=dokploy-release::${oneLine(message)}`);
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
		fail(error instanceof InputError ? error.message : `Unexpected error: ${error}`);
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
		if (error instanceof DeploymentError && delivery === "push") {
			console.log(
				`::warning title=dokploy-release::${oneLine(error.message)} The workflow's own deploy is not affected.`,
			);
			process.exit(0);
		}
		fail(error instanceof Error ? error.message : String(error));
	}
} else {
	console.log("::error title=dokploy-release::usage: cli.mjs manifest|deploy");
	process.exit(2);
}
