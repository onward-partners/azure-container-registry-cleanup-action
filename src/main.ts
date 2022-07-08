import * as core from '@actions/core';
import { ContainerRegistryClient, KnownContainerRegistryAudience } from '@azure/container-registry';
import { ClientSecretCredential } from '@azure/identity';


async function run(): Promise<void> {
  let totalDeletedImages = 0;
  try {

    const imagesToKeep = parseInt(core.getInput('keep'), 10);
    const dontCountUntaggedImages = core.getBooleanInput('dontCountUntaggedImages');
    const endpoint = core.getInput('endpoint');
    const repos = core.getInput('repos').split(/[,;\n\s]/).map(r => r.trim()).filter(r => r !== '');
    const tenantId = core.getInput('tenantId');
    const secret = core.getInput('secret');
    const clientId = core.getInput('clientId');
    const audienceString = core.getInput('audience');

    let audience: KnownContainerRegistryAudience;
    switch (audienceString.toLowerCase()) {
      case 'china':
        audience = KnownContainerRegistryAudience.AzureResourceManagerChina;
        break;
      case 'germany':
        audience = KnownContainerRegistryAudience.AzureResourceManagerGermany;
        break;
      case 'government':
        audience = KnownContainerRegistryAudience.AzureResourceManagerGovernment;
        break;
      default:
        audience = KnownContainerRegistryAudience.AzureResourceManagerPublicCloud;
        break;
    }

    core.debug(`imagesToKeep: ${ imagesToKeep }`);
    core.debug(`dontCountUntaggedImages: ${ dontCountUntaggedImages }`);
    core.debug(`endpoint: ${ endpoint }`);
    core.debug(`audience: ${ audience }`);
    core.debug(`repos: ${ repos }`);
    core.debug(`has tenantId: ${ tenantId && tenantId !== '' }`);
    core.debug(`has secret: ${ secret && secret !== '' }`);
    core.debug(`has clientId: ${ clientId && clientId !== '' }`);

    const client = new ContainerRegistryClient(
      endpoint,
      new ClientSecretCredential(tenantId, clientId, secret),
      { audience },
    );

    for (const repoName of repos) {
      await core.group(
        `🔍 Cleanup ${ repoName }`,
        async () => {
          const repo = client.getRepository(repoName);

          const imageManifests = repo.listManifestProperties({
            order: 'LastUpdatedOnDescending',
          });
          let imageCount = 0;
          let deletedImages = 0;
          for await (const manifest of imageManifests) {
            if ((dontCountUntaggedImages && manifest.tags.length === 0) || imageCount++ >= imagesToKeep) {
              await repo.getArtifact(manifest.digest).delete();
              deletedImages++;
              if (manifest.tags.length > 0) {
                core.info(`Delete image: ${ manifest.digest } - Tags: ${ manifest.tags }`);
              } else {
                core.info(`Delete image: ${ manifest.digest } - Tags: ${ manifest.tags }`);
              }
            }
          }
          core.info(`Deleted ${ deletedImages } image in ${ repoName }`);
          totalDeletedImages += deletedImages;
        },
      );
    }

    core.info(`Deleted ${ totalDeletedImages } images`);
    core.setOutput('count', totalDeletedImages);
  } catch (error) {
    core.info(`Deleted ${ totalDeletedImages } images`);
    core.setFailed(error as Error);
  }
}

void run();
