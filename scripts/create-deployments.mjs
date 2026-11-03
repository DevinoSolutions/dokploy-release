// Creates the GitHub Deployment of a release: the user-visible record and the
// wake-up signal Dokploy polls for. Nothing in it is trusted by Dokploy except
// the run id: the release itself is the run artifact.
//
// One Deployment per service key: ref = the commit, task = dokploy:<key>,
// required_contexts = [] (never waits on checks), auto_merge = false.

/** The GitHub call failed (network or API). The only error a push-mode release tolerates. */
export class DeploymentError extends Error {}

const MAX_WAIT_MS = 60_000;

// How long GitHub asked us to wait, in ms, or null. Honoured on 429, and on a
// 403 that carries Retry-After (the secondary rate limit).
const retryAfterMs = (response) => {
	const raw = response.headers?.get?.("retry-after");
	if (raw === null || raw === undefined) return null;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : null;
};

export const WAKE_SCHEMA = "dokploy.deployment/v1";

export const deploymentBody = (manifest, key) => ({
	ref: manifest.sha,
	task: `dokploy:${key}`,
	environment: manifest.environment,
	auto_merge: false,
	required_contexts: [],
	transient_environment: false,
	description: `Dokploy release ${manifest.release.id}`.slice(0, 140),
	payload: {
		schema: WAKE_SCHEMA,
		run_id: Number(manifest.source.runId),
		run_attempt: manifest.source.runAttempt,
		artifact: "dokploy-release",
	},
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ fetch: typeof fetch, token: string, repository: string, apiUrl?: string, sleep?: (ms: number) => Promise<void> }} deps
 * @returns {Promise<Array<{ key: string, id: number }>>}
 */
export const createDeployments = async (deps, manifest) => {
	const base = (deps.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(deps.repository)) {
		throw new Error("GITHUB_REPOSITORY is not owner/name.");
	}
	const wait = deps.sleep ?? sleep;
	const created = [];
	for (const key of manifest.release.services) {
		const body = JSON.stringify(deploymentBody(manifest, key));
		let lastError = "no attempt was made";
		let id = null;
		let waitMs = null;
		for (let attempt = 1; attempt <= 3 && id === null; attempt += 1) {
			try {
				const response = await deps.fetch(`${base}/repos/${deps.repository}/deployments`, {
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${deps.token}`,
						"X-GitHub-Api-Version": "2022-11-28",
						"Content-Type": "application/json",
						"User-Agent": "dokploy-release",
					},
					body,
				});
				if (response.status === 201) {
					const json = await response.json();
					id = Number(json?.id);
					if (!Number.isSafeInteger(id)) throw new Error("GitHub answered without a deployment id");
					break;
				}
				const text = (await response.text()).slice(0, 200);
				lastError = `HTTP ${response.status}: ${text}`;
				waitMs = response.status === 429 || response.status === 403 ? retryAfterMs(response) : null;
				// 4xx other than 429, and than a 403 that names a Retry-After, will not change on a retry.
				const retryable = response.status >= 500 || response.status === 429 || (response.status === 403 && waitMs !== null);
				if (!retryable) break;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			if (attempt < 3) await wait(waitMs ?? attempt * 1000);
			waitMs = null;
		}
		if (id === null) {
			throw new DeploymentError(`Could not create the GitHub Deployment for ${key}: ${lastError}`);
		}
		created.push({ key, id });
	}
	return created;
};
