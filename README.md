# dokploy-release

Publishes a release for [Dokploy](https://github.com/DevinoSolutions/dokploy-community) from a GitHub Actions run.
The action holds no Dokploy address and no Dokploy API key. It does two things:

1. Uploads the release manifest (`dokploy.release/v1`) as the run artifact `dokploy-release` (or, with `upload-artifact: false`, only prints it in the job log).
2. Creates one GitHub Deployment per service (`task: dokploy:<key>`, `ref` = the commit sha) as the wake-up record.

Dokploy polls GitHub (outbound only), reads the artifact, checks it against the run, and deploys the digest.
When GitHub blocks artifact uploads (the Actions storage quota is used up), the same manifest is also printed as one log line,
`dokploy-release/v1 <payload>` (the compact manifest JSON, one letter g-v per nibble: the runner masks secrets and their base64 forms in logs, and a short secret such as a port would match hex digits),
and Dokploy reads it from the log of the release job instead. The Deployment is still created, the upload step only warns, and every
check Dokploy makes is the same for either source. Do not keep image digests, registry hosts, repository names or service keys in
secrets, and avoid very short secrets: a masked value (`***`) in that line makes Dokploy refuse the release. A 64 KiB manifest is a ~128 KiB log line.
The Deployment payload also carries `job` (GITHUB_JOB) and `runner` (RUNNER_NAME) as hints for which job log to read.
The Deployment is only a signal. The artifact is the record Dokploy trusts, because only the run itself can upload its own artifacts.

## Use it (phase 1: your own job builds and pushes the image)

Add one job after the job that pushes your image. Take the image from an output of that job in the same run.

```yaml
  dokploy-release:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production        # deployment branches limited to main
    permissions:
      contents: read
      deployments: write
    steps:
      - uses: DevinoSolutions/dokploy-release@v1
        with:
          service: shop
          environment: production
          delivery: pull           # push while your workflow still calls the Dokploy API
          existing-image: ${{ needs.build.outputs.image }}   # ghcr.io/acme/shop@sha256:...
```

Rules the action enforces:

- `upload-artifact` (default `true`) controls the run artifact. With `false` the artifact upload step is skipped entirely and the
  manifest exists only as the `dokploy-release/v1 <payload>` line in the release job's log, which Dokploy reads the same way
  (same checks, same trust). Use it when a repository's policy forbids `actions/upload-artifact` or when it has no artifact storage.
  The output `artifact-uploaded` is then `false`. Existing workflows keep uploading. Any value other than `true` or `false` fails the step.
  A run publishes one manifest: a log-only release must not share its run with another `dokploy-release` call (two markers in one run are refused as ambiguous).
- The image must be `<repository>@sha256:<digest>`, in lowercase. A tag is refused.
- Several services are written `key=image` or `key/composeService=image`, one per line.
- The run must come from a branch and from a `push` or a manual `workflow_dispatch`. Other events (`pull_request`, `pull_request_target`, `workflow_run`, `schedule`) are refused.
- The inputs `image`, `dockerfile`, `context`, `builder`, `registry`, `mode`, `migrations`, `cache`, `environments`, `secrets`, `build-args` and `target` are reserved for later versions.
  They are declared so that a typo cannot pass silently: any non-empty value fails the step with "not supported in v1".

`delivery: push` publishes the same manifest but tells Dokploy not to deploy it: your own workflow still deploys, and
Dokploy only verifies the release and advances its record of the deployed commit.
A bad input or configuration fails the step in both delivery modes. Only a network or API failure while creating the
GitHub Deployment is a warning in `push` mode, so a GitHub outage never blocks a deploy your own workflow performs.

The action sets up Node 22 itself (self-hosted images often have no node on `PATH`).

## Files

| Path | What it is |
|---|---|
| `action.yml` | The composite action. Third-party actions are pinned by commit sha. |
| `schema/dokploy.release.v1.schema.json` | JSON Schema of the manifest. |
| `fixtures/` | Valid and invalid manifests (`index.json` lists them). Dokploy vendors these and pins their hash. |
| `scripts/` | `build-manifest.mjs`, `create-deployments.mjs`, `cli.mjs`, and the fixture generator and validator. |

Run `npm test` for the unit tests, `npm run fixtures` to regenerate the fixtures after a manifest change, and `npm run validate` to
check them against the schema.

## License

MIT, Devino Solutions.
