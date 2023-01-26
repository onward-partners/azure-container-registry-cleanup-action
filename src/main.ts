import * as core from '@actions/core';
import { ContainerRegistryClient, KnownContainerRegistryAudience } from '@azure/container-registry';
import { ClientSecretCredential } from '@azure/identity';


async function run(): Promise<void> {
  let totalDeletedImages = 0;
  try {
    
    const imagesToKeep = parseInt(core.getInput('keep'), 10);
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

          // artifacts must be listed in descending order so that any related manifest will come after it. 
          // reversing the order could cause a manifest to become corrupted
          const imageManifests = repo.listManifestProperties({
            order: 'LastUpdatedOnDescending',
          });

          let imageCount = 0;
          let deletedImages = 0;
          const artifactsToKeep: string[] = [];
          for await (const manifest of imageManifests) {
            // get manifest properties to retrieve the related artifacts data
            const manifestProperties = await repo.getArtifact(manifest.digest).getManifestProperties();

            // retain artifact only if it is tagged and still within the [imagesToKeep] limit or required by another artifact
            if ((manifest.tags.length && imageCount++ < imagesToKeep) || artifactsToKeep.includes(manifest.digest)) {
              artifactsToKeep.push(...manifestProperties.relatedArtifacts.map(el => el.digest));
              continue;
            }
            
            await repo.getArtifact(manifest.digest).delete();
            core.info(`Deleted image: ${ manifest.digest } - Tags: ${ manifest.tags.length ? manifest.tags.join(', ') : '<null>' }`);
            deletedImages++;
          }
          core.info(`Deleted ${ deletedImages } images in ${ repoName }`);
          totalDeletedImages += deletedImages;
        },
      );
    }

    core.info(`Deleted ${ totalDeletedImages } images`);
    core.setOutput('count', totalDeletedImages);
  } catch (error) {
    core.info(`Deleted ${ totalDeletedImages } images`);
    core.setFailed(error as Error);;
  }
}

void run();
