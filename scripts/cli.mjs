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
import { parseReadyOptions, ReadyOptionError, RegistryNotReadyError, waitForRegistryReady } from "./registry-ready.mjs";

// The line Dokploy looks for in the job log: `dokploy-release/v1 <payload>`. The payload is the UTF-8 bytes of the
// compact manifest JSON, one letter per nibble (0 is "g", 15 is "v", high nibble first), so it only contains the
// letters g to v. Not base64, because the runner masks secret values and their base64 forms in logs (an organization
// has seen image digests masked that way); not hex, because a short secret made of 0-9a-f (a port, a PIN) would occur
// by chance in hex text and get masked. No leading "::", so the runner's workflow command parser is never involved.
// A 64 KiB manifest is a ~128 KiB line. Keep in step with Dokploy's log-manifest.ts (encodeMarkerPayload).
const LOG_MARKER = "dokploy-release/v1 ";
const encodePayload = (text) => {
	let out = "";
	for (const byte of Buffer.from(text, "utf8")) {
		out += String.fromCharCode(103 + (byte >> 4), 103 + (byte & 15));
	}
	return out;
};

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
		// upload-artifact only decides whether the action uploads the artifact; a typo must not pass silently.
		const upload = String(process.env.INPUT_UPLOAD_ARTIFACT ?? "").trim().toLowerCase();
		if (upload !== "" && upload !== "true" && upload !== "false") {
			throw new InputError('The input upload-artifact must be "true" or "false"');
		}
		const ready = parseReadyOptions(process.env);
		const manifest = buildManifest(process.env);
		// Wait until the registry serves every released digest before anything is published: Dokploy pulls it
		// right after the release, and a registry can lag behind the push (GHCR: minutes for a new digest).
		if (ready.enabled) {
			if (ready.token !== "") console.log(`::add-mask::${ready.token}`);
			const refs = manifest.services.flatMap((service) => service.images.map((image) => image.ref));
			await waitForRegistryReady({ refs, token: ready.token, timeoutSeconds: ready.timeoutSeconds });
		} else {
			console.log("Registry readiness probe is off (registry-ready: false).");
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
		output("path", file);
		output("release-id", manifest.release.id);
		output("published", "true");
		console.log(`Release ${manifest.release.id}: ${manifest.release.services.join(", ")} (${manifest.delivery})`);
		// A second copy of the manifest for Dokploy, on one line of its own: when GitHub blocks the artifact
		// upload (Actions storage quota) Dokploy reads this line from the job log instead. Same manifest, same checks.
		console.log(`${LOG_MARKER}${encodePayload(JSON.stringify(manifest))}`);
	} catch (error) {
		fail(
			error instanceof InputError || error instanceof ReadyOptionError || error instanceof RegistryNotReadyError
				? error.message
				: `Unexpected error: ${error}`,
		);
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
				env: process.env,
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
