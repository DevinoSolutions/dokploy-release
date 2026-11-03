# dokploy-release

Publishes a release for [Dokploy](https://github.com/DevinoSolutions/dokploy-community) from a GitHub Actions run.
The action holds no Dokploy address and no Dokploy API key. It does two things:

1. Uploads the release manifest (`dokploy.release/v1`) as the run artifact `dokploy-release`.
2. Creates one GitHub Deployment per service (`task: dokploy:<key>`, `ref` = the commit sha) as the wake-up record.

Dokploy polls GitHub (outbound only), reads the artifact, checks it against the run, and deploys the digest.
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

Rules the action enforces: the image must be `<repository>@sha256:<digest>` (a tag is refused), no build inputs are accepted yet
(`image`, `dockerfile`, `context`, `builder`, `registry` arrive later), and several services are written `key=image` or
`key/composeService=image`, one per line.

`delivery: push` publishes the same manifest but tells Dokploy not to deploy it: your own workflow still deploys, and
Dokploy only verifies the release and advances its record of the deployed commit. In that mode a failure to publish only warns.

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
