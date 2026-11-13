import { describe, expect, it } from 'vitest';
import { cosignSubject, ManifestInfo, selectManifestsToKeep } from '../src/select.js';

const hex = (c: string) => c.repeat(64);
const digest = (c: string) => `sha256:${hex(c)}`;
const sigTag = (c: string, kind = 'sig') => `sha256-${hex(c)}.${kind}`;

const image = (c: string, ...tags: string[]): ManifestInfo => ({ digest: digest(c), tags });
const signature = (subject: string, signatureDigest: string, kind = 'sig'): ManifestInfo => ({
  digest: digest(signatureDigest),
  tags: [sigTag(subject, kind)],
});

type Related = Record<string, string[]>;

async function select(
  manifests: ManifestInfo[],
  options: { keep?: number; deleteOrphans?: boolean; related?: Related } = {},
) {
  const { keep = 2, deleteOrphans = true, related = {} } = options;
  const kept = await selectManifestsToKeep({
    manifests,
    imagesToKeep: keep,
    deleteOrphanedSignatures: deleteOrphans,
    getRelatedDigests: async d => related[d] ?? [],
  });
  return manifests.filter(m => kept.has(m.digest)).map(m => m.digest);
}

describe('cosignSubject', () => {
  it.each(['sig', 'att', 'sbom'])('resolves the subject of a .%s tag', kind => {
    expect(cosignSubject([sigTag('a', kind)])).toBe(digest('a'));
  });

  it('finds the signature tag among other tags', () => {
    expect(cosignSubject(['latest', sigTag('b')])).toBe(digest('b'));
  });

  it.each([
    [[]],
    [['latest']],
    [['v1.0.sig']],
    [[`sha256-${'a'.repeat(63)}.sig`]], // too short
    [[`sha256-${'A'.repeat(64)}.sig`]], // upper case
    [[`sha256-${hex('a')}.sig.bak`]],
    [[`sha256-${hex('a')}.txt`]],
  ])('ignores non-cosign tags %j', tags => {
    expect(cosignSubject(tags)).toBeUndefined();
  });
});

describe('selectManifestsToKeep', () => {
  it('keeps the newest tagged images up to the limit', async () => {
    const manifests = [image('1', 'v3'), image('2', 'v2'), image('3', 'v1')];
    expect(await select(manifests, { keep: 2 })).toEqual([digest('1'), digest('2')]);
  });

  it('does not count untagged manifests towards the limit', async () => {
    const manifests = [image('1'), image('2', 'v2'), image('3'), image('4', 'v1')];
    expect(await select(manifests, { keep: 2 })).toEqual([digest('2'), digest('4')]);
  });

  it('keeps nothing if the limit is 0', async () => {
    expect(await select([image('1', 'v1')], { keep: 0 })).toEqual([]);
  });

  describe('signatures', () => {
    it('does not count signatures towards the limit', async () => {
      // newest first: every image is followed by its signature
      const manifests = [
        signature('1', 'a'),
        image('1', 'v3'),
        signature('2', 'b'),
        image('2', 'v2'),
        signature('3', 'c'),
        image('3', 'v1'),
      ];
      expect(await select(manifests, { keep: 2 })).toEqual([
        digest('a'),
        digest('1'),
        digest('b'),
        digest('2'),
      ]);
    });

    it('keeps a signature that is older than its image', async () => {
      const manifests = [image('1', 'v1'), signature('1', 'a')];
      expect(await select(manifests, { keep: 1 })).toEqual([digest('1'), digest('a')]);
    });

    it('keeps a signature that is newer than its image', async () => {
      const manifests = [signature('1', 'a'), image('1', 'v1')];
      expect(await select(manifests, { keep: 1 })).toEqual([digest('a'), digest('1')]);
    });

    it('deletes the signature together with its deleted image', async () => {
      const manifests = [image('1', 'v2'), image('2', 'v1'), signature('2', 'a')];
      expect(await select(manifests, { keep: 1 })).toEqual([digest('1')]);
    });

    it.each(['att', 'sbom'])('treats .%s like a signature', async kind => {
      const manifests = [
        image('1', 'v2'),
        image('2', 'v1'),
        signature('1', 'a', kind),
        signature('2', 'b', kind),
      ];
      expect(await select(manifests, { keep: 1 })).toEqual([digest('1'), digest('a')]);
    });

    it('keeps all signature kinds of a kept image', async () => {
      const manifests = [
        image('1', 'v1'),
        signature('1', 'a', 'sig'),
        signature('1', 'b', 'att'),
        signature('1', 'c', 'sbom'),
      ];
      expect(await select(manifests, { keep: 1 })).toEqual(manifests.map(m => m.digest));
    });

    it('keeps a signature if its subject is kept as a related artifact', async () => {
      // image 1 is an index that references the untagged platform manifest 2, which is signed
      const manifests = [image('1', 'v1'), image('2'), signature('2', 'a')];
      const related = { [digest('1')]: [digest('2')] };
      expect(await select(manifests, { keep: 1, related })).toEqual([
        digest('1'),
        digest('2'),
        digest('a'),
      ]);
    });
  });

  describe('orphaned signatures', () => {
    // the signed image 9 does not exist in the repository
    const manifests = [image('1', 'v1'), signature('9', 'a')];

    it('deletes them by default', async () => {
      expect(await select(manifests, { keep: 1, deleteOrphans: true })).toEqual([digest('1')]);
    });

    it('keeps them if deleteOrphanedSignatures is false', async () => {
      expect(await select(manifests, { keep: 1, deleteOrphans: false })).toEqual([
        digest('1'),
        digest('a'),
      ]);
    });

    it('still deletes signatures of deleted images if deleteOrphanedSignatures is false', async () => {
      // image 2 exists but falls out of the limit, so its signature is not an orphan
      const withDeleted = [
        image('1', 'v2'),
        image('2', 'v1'),
        signature('2', 'a'),
        signature('9', 'b'),
      ];
      expect(await select(withDeleted, { keep: 1, deleteOrphans: false })).toEqual([
        digest('1'),
        digest('b'),
      ]);
    });
  });

  describe('related artifacts', () => {
    it('keeps artifacts referenced by a kept image', async () => {
      const manifests = [image('1', 'v1'), image('2'), image('3')];
      const related = { [digest('1')]: [digest('2')] };
      expect(await select(manifests, { keep: 1, related })).toEqual([digest('1'), digest('2')]);
    });

    it('follows nested references', async () => {
      const manifests = [image('1', 'v1'), image('2'), image('3'), image('4')];
      const related = { [digest('1')]: [digest('2')], [digest('2')]: [digest('3')] };
      expect(await select(manifests, { keep: 1, related })).toEqual([
        digest('1'),
        digest('2'),
        digest('3'),
      ]);
    });

    it('keeps a referenced artifact regardless of list order', async () => {
      const manifests = [image('2'), image('1', 'v1')];
      const related = { [digest('1')]: [digest('2')] };
      expect(await select(manifests, { keep: 1, related })).toEqual([digest('2'), digest('1')]);
    });

    it('does not read related artifacts of deleted images', async () => {
      const looked: string[] = [];
      await selectManifestsToKeep({
        manifests: [image('1', 'v2'), image('2', 'v1')],
        imagesToKeep: 1,
        deleteOrphanedSignatures: true,
        getRelatedDigests: async d => {
          looked.push(d);
          return [];
        },
      });
      expect(looked).toEqual([digest('1')]);
    });

    it('terminates on circular references', async () => {
      const manifests = [image('1', 'v1'), image('2')];
      const related = { [digest('1')]: [digest('2')], [digest('2')]: [digest('1')] };
      expect(await select(manifests, { keep: 1, related })).toEqual([digest('1'), digest('2')]);
    });
  });

  it('returns an empty set for an empty repository', async () => {
    expect(await select([])).toEqual([]);
  });
});
