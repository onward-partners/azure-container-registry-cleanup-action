# Get affected Nx apps action

This action gets the apps affected by the changes since the last successful build and sets them as outputs.

## Inputs


### `keep`

Amount of images to keep. Default: `3`

### `dontCountUntaggedImages`

If set to true all untagged images will not add to the amount of kept images. Default: `true`

### `tenantId`

**Required** Azure Tenant ID

### `secret`

**Required** Azure Secret

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
