Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@actions/core");
const container_registry_1 = require("@azure/container-registry");
const identity_1 = require("@azure/identity");
async function run() {
    let totalDeletedImages = 0;
    try {
        const imagesToKeep = parseInt((0, core_1.getInput)('keep'), 10);
        const endpoint = (0, core_1.getInput)('endpoint');
        const repos = (0, core_1.getInput)('repos')
            .split(/[,;\n\s]/)
            .map(r => r.trim())
            .filter(r => r !== '');
        const tenantId = (0, core_1.getInput)('tenantId');
        const secret = (0, core_1.getInput)('secret');
        const clientId = (0, core_1.getInput)('clientId');
        const audienceString = (0, core_1.getInput)('audience');
        let audience;
        switch (audienceString.toLowerCase()) {
            case 'china':
                audience = container_registry_1.KnownContainerRegistryAudience.AzureResourceManagerChina;
                break;
            case 'germany':
                audience = container_registry_1.KnownContainerRegistryAudience.AzureResourceManagerGermany;
                break;
            case 'government':
                audience = container_registry_1.KnownContainerRegistryAudience.AzureResourceManagerGovernment;
                break;
            default:
                audience = container_registry_1.KnownContainerRegistryAudience.AzureResourceManagerPublicCloud;
                break;
        }
        (0, core_1.debug)(`imagesToKeep: ${imagesToKeep}`);
        (0, core_1.debug)(`endpoint: ${endpoint}`);
        (0, core_1.debug)(`audience: ${audience}`);
        (0, core_1.debug)(`repos: ${repos}`);
        (0, core_1.debug)(`has tenantId: ${tenantId && tenantId !== ''}`);
        (0, core_1.debug)(`has secret: ${secret && secret !== ''}`);
        (0, core_1.debug)(`has clientId: ${clientId && clientId !== ''}`);
        const client = new container_registry_1.ContainerRegistryClient(endpoint, new identity_1.ClientSecretCredential(tenantId, clientId, secret), {
            audience,
        });
        for (const repoName of repos) {
            await (0, core_1.group)(`🔍 Cleanup ${repoName}`, async () => {
                const repo = client.getRepository(repoName);
                // artifacts must be listed in descending order so that any related manifest will come after it.
                // reversing the order could cause a manifest to become corrupted
                const imageManifests = repo.listManifestProperties({
                    order: 'LastUpdatedOnDescending',
                });
                let imageCount = 0;
                let deletedImages = 0;
                const artifactsToKeep = [];
                for await (const manifest of imageManifests) {
                    // get manifest properties to retrieve the related artifacts data
                    const manifestProperties = await repo
                        .getArtifact(manifest.digest)
                        .getManifestProperties();
                    // retain artifact only if it is tagged and still within the [imagesToKeep] limit or required by another artifact
                    if ((manifest.tags.length && imageCount++ < imagesToKeep) ||
                        artifactsToKeep.includes(manifest.digest)) {
                        artifactsToKeep.push(...manifestProperties.relatedArtifacts.map(el => el.digest));
                        continue;
                    }
                    await repo.getArtifact(manifest.digest).delete();
                    (0, core_1.info)(`Deleted image: ${manifest.digest} - Tags: ${manifest.tags.length ? manifest.tags.join(', ') : '<null>'}`);
                    deletedImages++;
                }
                (0, core_1.info)(`Deleted ${deletedImages} images in ${repoName}`);
                totalDeletedImages += deletedImages;
            });
        }
        (0, core_1.info)(`Deleted ${totalDeletedImages} images`);
        (0, core_1.setOutput)('count', totalDeletedImages);
    }
    catch (error) {
        (0, core_1.info)(`Deleted ${totalDeletedImages} images`);
        (0, core_1.setFailed)(error);
    }
}
void run();
//# sourceMappingURL=index.js.map
