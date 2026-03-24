import { debug, getInput, group, info, setFailed, setOutput } from '@actions/core';
import { ContainerRegistryClient, KnownContainerRegistryAudience } from '@azure/container-registry';
import { ClientSecretCredential } from '@azure/identity';

async function run(): Promise<void> {
  let totalDeletedImages = 0;
  try {
    const imagesToKeep = parseInt(getInput('keep'), 10);
    const endpoint = getInput('endpoint');
    const repos = getInput('repos')
      .split(/[,;\n\s]/)
      .map(r => r.trim())
      .filter(r => r !== '');
    const tenantId = getInput('tenantId');
    const secret = getInput('secret');
    const clientId = getInput('clientId');
    const audienceString = getInput('audience');

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

    debug(`imagesToKeep: ${imagesToKeep}`);
    debug(`endpoint: ${endpoint}`);
    debug(`audience: ${audience}`);
    debug(`repos: ${repos}`);
    debug(`has tenantId: ${tenantId && tenantId !== ''}`);
    debug(`has secret: ${secret && secret !== ''}`);
    debug(`has clientId: ${clientId && clientId !== ''}`);

    const client = new ContainerRegistryClient(
      endpoint,
      new ClientSecretCredential(tenantId, clientId, secret),
      {
        audience,
      },
    );

    for (const repoName of repos) {
      await group(`🔍 Cleanup ${repoName}`, async () => {
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
          const manifestProperties = await repo
            .getArtifact(manifest.digest)
            .getManifestProperties();

          // retain artifact only if it is tagged and still within the [imagesToKeep] limit or required by another artifact
          if (
            (manifest.tags.length && imageCount++ < imagesToKeep) ||
            artifactsToKeep.includes(manifest.digest)
          ) {
            artifactsToKeep.push(...manifestProperties.relatedArtifacts.map(el => el.digest));
            continue;
          }

          await repo.getArtifact(manifest.digest).delete();
          info(
            `Deleted image: ${manifest.digest} - Tags: ${manifest.tags.length ? manifest.tags.join(', ') : '<null>'}`,
          );
          deletedImages++;
        }
        info(`Deleted ${deletedImages} images in ${repoName}`);
        totalDeletedImages += deletedImages;
      });
    }

    info(`Deleted ${totalDeletedImages} images`);
    setOutput('count', totalDeletedImages);
  } catch (error) {
    info(`Deleted ${totalDeletedImages} images`);
    setFailed(error as Error);
  }
}

void run();
