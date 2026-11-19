# Get affected Nx apps action

This action gets the apps affected by the changes since the last successful build and sets them as outputs.

## Inputs

### `keep`

Amount of images to keep. Default: `3`

### `dontCountUntaggedImages`

If set to true all untagged images will not add to the amount of kept images. Default: `true`

### `deleteOrphanedSignatures`

Cosign signatures, attestations and SBOMs (tags `sha256-<digest>.sig`, `.att`, `.sbom`) are not counted towards `keep`. They are kept or deleted together with the image they belong to. If set to `true`, signatures whose image no longer exists in the repository are deleted as well; set to `false` to keep them. Default: `true`

### `tenantId`

**Required** Azure Tenant ID

### `secret`

Azure client secret. If omitted, the action authenticates via GitHub OIDC (see [Authentication with OIDC](#authentication-with-oidc)).

### `oidcAudience`

Audience of the GitHub OIDC token, used when no `secret` is provided. Default: `api://AzureADTokenExchange`

### `clientId`

**Required** Azure Client ID

### `repos`

**Required** Repos that will be cleaned. Can be seperated by spaces, comma, semicolon or new line

### `endpoint`

**Required** Azure Container Registry endpoint'

### `github_token`

**Required** Your GitHub access token (see Usage below).

### `workflow_id`

**Required** The `id` of the workflow to check against (e.g. main.yml).

### `branch`

Branch to get last successful commit from. Default: `main`

## Outputs

### `repos`

An array of all affected apps.

### `endpoint`

A comma seperated string of all affected apps

## Outputs

### `count`

The amount of images that got deleted

## Example usage

```yaml
jobs:
  cleanup-acr:
    runs-on: ubuntu-latest
    name: Cleanup ACR
    outputs:
      deletedImageCount: ${{ steps.acr-cleanup.outputs.count }}
    steps:
      - uses: i40MC/azure-container-registry-cleanup-action@v1
        id: acr-cleanup
        with:
          keep: 3
          dontCountUntaggedImages: true
          tenantId: <Azure-Tenant-ID>
          secret: <Azure-Secret>
          clientId: <Azure-Client-ID>
          repos: repo-a repo-b,repo-c;repo-d
          endpoint: example.azurecr.io
```

## Authentication with OIDC

Instead of storing a client secret you can let the action authenticate with the GitHub OIDC token (workload identity federation):

1. In Azure, add a **federated credential** to your app registration (issuer `https://token.actions.githubusercontent.com`, subject e.g. `repo:<owner>/<repo>:ref:refs/heads/main`, audience `api://AzureADTokenExchange`).
2. Grant the app registration the `AcrDelete` and `AcrPull` roles on the registry.
3. Give the job `id-token: write` permission and omit `secret`:

```yaml
jobs:
  cleanup-acr:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: i40MC/azure-container-registry-cleanup-action@v2
        with:
          tenantId: <Azure-Tenant-ID>
          clientId: <Azure-Client-ID>
          repos: repo-a repo-b
          endpoint: example.azurecr.io
```
