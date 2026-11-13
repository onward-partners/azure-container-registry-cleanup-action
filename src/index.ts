import { debug, getBooleanInput, getInput, group, info, setFailed, setOutput } from '@actions/core';
import { ContainerRegistryClient, KnownContainerRegistryAudience } from '@azure/container-registry';
import { ClientSecretCredential } from '@azure/identity';
import { ManifestInfo, selectManifestsToKeep } from './select.js';

async function run(): Promise<void> {
  let totalDeletedImages = 0;
  try {
    const imagesToKeep = parseInt(getInput('keep'), 10);
    const deleteOrphanedSignatures = getBooleanInput('deleteOrphanedSignatures');
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
    debug(`deleteOrphanedSignatures: ${deleteOrphanedSignatures}`);
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

        // pass 1: read all manifests, newest first
        const manifests: ManifestInfo[] = [];
        for await (const manifest of repo.listManifestProperties({
          order: 'LastUpdatedOnDescending',
        })) {
          manifests.push({ digest: manifest.digest, tags: manifest.tags ?? [] });
        }

        // pass 2: decide which manifests to keep
        const keep = await selectManifestsToKeep({
          manifests,
          imagesToKeep,
          deleteOrphanedSignatures,
          getRelatedDigests: async digest => {
            const properties = await repo.getArtifact(digest).getManifestProperties();
            return properties.relatedArtifacts.map(related => related.digest);
          },
        });

        // pass 3: delete everything that is not kept
        let deletedImages = 0;
        for (const manifest of manifests) {
          if (keep.has(manifest.digest)) continue;
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
