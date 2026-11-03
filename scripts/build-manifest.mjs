// Builds the release manifest (dokploy.release/v1) from the action's inputs and
// the GitHub Actions run context. No dependency, no network: it only reads the
// environment it is given, so it is tested with plain objects.
//
// Phase 1 builds nothing: the image comes from `existing-image`, taken from an
// output of a job in the same run. A tag is refused.

const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const COMPOSE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMPOSE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const SHA = /^[0-9a-f]{40}$/;
const REF = new RegExp(
	"^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?/)?" +
		"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*" +
		"@sha256:[0-9a-f]{64}$",
);

export class InputError extends Error {}

// Declared in action.yml so a typo cannot pass silently: any non-empty value is refused.
export const UNSUPPORTED_INPUTS = [
	"IMAGE",
	"DOCKERFILE",
	"CONTEXT",
	"BUILDER",
	"REGISTRY",
	"MODE",
	"MIGRATIONS",
	"CACHE",
	"ENVIRONMENTS",
	"SECRETS",
	"BUILD_ARGS",
	"TARGET",
];

const lines = (value) =>
	String(value ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

/**
 * @param {Record<string, string | undefined>} env
 * @returns {object} the manifest
 */
export const buildManifest = (env) => {
	const event = String(env.GITHUB_EVENT_NAME ?? "");
	if (event !== "push" && event !== "workflow_dispatch") {
		throw new InputError(
			`A release is published from a push or a manual run (workflow_dispatch); this run was triggered by ${JSON.stringify(event || "no event")}.`,
		);
	}

	for (const unsupported of UNSUPPORTED_INPUTS) {
		if (String(env[`INPUT_${unsupported}`] ?? "").trim() !== "") {
			throw new InputError(
				`The input ${unsupported.toLowerCase().replaceAll("_", "-")} is not supported in v1 of this action; it is reserved for a later version. Build and push in your own job and pass its output as existing-image.`,
			);
		}
	}

	const keys = [...lines(env.INPUT_SERVICES), ...lines(env.INPUT_SERVICE)];
	if (keys.length === 0) {
		throw new InputError("Name the service with the service input (or services).");
	}
	for (const key of keys) {
		if (!KEY.test(key)) {
			throw new InputError(
				`Service key ${JSON.stringify(key)} must be lowercase letters, digits, dots, dashes or underscores.`,
			);
		}
	}
	if (new Set(keys).size !== keys.length) {
		throw new InputError("A service key is listed twice.");
	}

	const delivery = String(env.INPUT_DELIVERY ?? "pull").trim() || "pull";
	if (delivery !== "pull" && delivery !== "push") {
		throw new InputError('delivery must be "pull" or "push".');
	}
	const environment = String(env.INPUT_ENVIRONMENT ?? "").trim();
	if (environment === "" || environment.length > 255) {
		throw new InputError("environment is required (the GitHub Environment name).");
	}
	const compose = String(env.INPUT_COMPOSE ?? "").trim();
	if (compose !== "" && (!COMPOSE_PATH.test(compose) || compose.split("/").includes(".."))) {
		throw new InputError("compose must be a relative path inside the repository.");
	}

	const images = new Map(keys.map((key) => [key, []]));
	for (const line of lines(env.INPUT_EXISTING_IMAGE)) {
		const eq = line.indexOf("=");
		let target = null;
		let ref = line;
		if (eq > 0 && !line.slice(0, eq).includes("@")) {
			target = line.slice(0, eq).trim();
			ref = line.slice(eq + 1).trim();
		}
		if (!REF.test(ref) && REF.test(ref.toLowerCase())) {
			throw new InputError(
				`existing-image must be lowercase: ${JSON.stringify(ref.slice(0, 120))} has uppercase letters, which a registry name and a sha256 digest cannot have.`,
			);
		}
		if (!REF.test(ref)) {
			throw new InputError(
				`existing-image must be <repository>@sha256:<64 hex>; ${JSON.stringify(ref.slice(0, 120))} is not. A tag is refused: pass the digest your build job output.`,
			);
		}
		let key;
		let composeService;
		if (target === null) {
			if (keys.length !== 1) {
				throw new InputError(
					"With several services, write each image as <key>=<image> or <key>/<compose service>=<image>.",
				);
			}
			key = keys[0];
			composeService = key;
		} else {
			const slash = target.indexOf("/");
			key = slash < 0 ? target : target.slice(0, slash);
			composeService = slash < 0 ? target : target.slice(slash + 1);
		}
		if (!images.has(key)) {
			throw new InputError(`existing-image names ${JSON.stringify(key)}, which is not one of the services.`);
		}
		if (!COMPOSE_SERVICE.test(composeService)) {
			throw new InputError(`${JSON.stringify(composeService)} is not a compose service name.`);
		}
		const list = images.get(key);
		if (list.some((image) => image.composeService === composeService)) {
			throw new InputError(`${key} has two images for ${composeService}.`);
		}
		list.push({ name: composeService, composeService, ref });
	}
	for (const [key, list] of images) {
		if (list.length === 0) {
			throw new InputError(`Service ${key} has no image: set existing-image.`);
		}
	}

	const sha = String(env.GITHUB_SHA ?? "");
	const ref = String(env.GITHUB_REF ?? "");
	const runId = String(env.GITHUB_RUN_ID ?? "");
	const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? "");
	if (!SHA.test(sha)) throw new InputError("GITHUB_SHA is not a commit sha.");
	if (!ref.startsWith("refs/heads/")) {
		throw new InputError(`A release is made from a branch; this run is on ${ref || "no ref"}.`);
	}
	if (!/^[0-9]{1,18}$/.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1) {
		throw new InputError("The run id or attempt is missing.");
	}

	return {
		schema: "dokploy.release/v1",
		sha,
		delivery,
		release: { id: `gh-${runId}.${attempt}`, services: keys },
		source: { forge: "github", ref, runId, runAttempt: attempt },
		environment,
		services: keys.map((key) => ({
			key,
			images: images.get(key),
			...(compose === "" ? {} : { compose: { path: compose } }),
			migrations: null,
		})),
	};
};
