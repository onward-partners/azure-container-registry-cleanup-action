const COSIGN_TAG = /^sha256-([a-f0-9]{64})\.(sig|att|sbom)$/;

export interface ManifestInfo {
  digest: string;
  tags: string[];
}

export interface SelectOptions {
  /** all manifests of a repository, newest first */
  manifests: ManifestInfo[];
  imagesToKeep: number;
  deleteOrphanedSignatures: boolean;
  /** returns the digests of the artifacts a manifest references (platform manifests, OCI referrers, ...) */
  getRelatedDigests: (digest: string) => Promise<string[]>;
}

/** Returns the digest a cosign signature/attestation/sbom tag refers to, if any. */
export function cosignSubject(tags: string[]): string | undefined {
  for (const tag of tags) {
    const match = COSIGN_TAG.exec(tag);
    if (match) return `sha256:${match[1]}`;
  }
  return undefined;
}

/** Returns the digests of all manifests that must be kept. Everything else can be deleted. */
export async function selectManifestsToKeep({
  manifests,
  imagesToKeep,
  deleteOrphanedSignatures,
  getRelatedDigests,
}: SelectOptions): Promise<Set<string>> {
  const existingDigests = new Set(manifests.map(m => m.digest));
  const keep = new Set<string>();

  // cosign signature tags are not images and must not count towards [imagesToKeep]
  let imageCount = 0;
  for (const manifest of manifests) {
    if (cosignSubject(manifest.tags)) continue;
    if (manifest.tags.length && imageCount++ < imagesToKeep) {
      keep.add(manifest.digest);
    }
  }

  // artifacts referenced by a kept manifest are kept too. runs until nothing new
  // is added, so nested references are covered
  let pending = [...keep];
  while (pending.length) {
    const next: string[] = [];
    for (const digest of pending) {
      for (const related of await getRelatedDigests(digest)) {
        if (!keep.has(related)) {
          keep.add(related);
          next.push(related);
        }
      }
    }
    pending = next;
  }

  // cosign signatures follow their subject. a signature whose subject does not exist
  // (orphan) is only kept if [deleteOrphanedSignatures] is disabled
  for (const manifest of manifests) {
    const subject = cosignSubject(manifest.tags);
    if (!subject) continue;
    if (keep.has(subject) || (!existingDigests.has(subject) && !deleteOrphanedSignatures)) {
      keep.add(manifest.digest);
    }
  }

  return keep;
}
