import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeManifest {
  digest: string;
  tags?: string[];
  related?: string[];
}

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  info: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  clientArgs: [] as unknown[][],
  credentialArgs: [] as unknown[][],
  listCalls: [] as { repo: string; options: unknown }[],
  deleted: [] as { repo: string; digest: string }[],
  repos: {} as Record<string, FakeManifest[]>,
  failDeleteOf: undefined as string | undefined,
}));

vi.mock('@actions/core', () => ({
  getInput: (name: string) => mocks.inputs[name] ?? '',
  getBooleanInput: (name: string) => {
    const value = mocks.inputs[name];
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new TypeError(`Input does not meet YAML 1.2 "Core Schema" specification: ${name}`);
  },
  group: async (_name: string, fn: () => Promise<unknown>) => fn(),
  info: mocks.info,
  debug: mocks.debug,
  setFailed: mocks.setFailed,
  setOutput: mocks.setOutput,
}));

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    constructor(...args: unknown[]) {
      mocks.credentialArgs.push(args);
    }
  },
}));

vi.mock('@azure/container-registry', () => ({
  KnownContainerRegistryAudience: {
    AzureResourceManagerChina: 'china-audience',
    AzureResourceManagerGermany: 'germany-audience',
    AzureResourceManagerGovernment: 'government-audience',
    AzureResourceManagerPublicCloud: 'public-audience',
  },
  ContainerRegistryClient: class {
    constructor(...args: unknown[]) {
      mocks.clientArgs.push(args);
    }

    getRepository(repo: string) {
      const manifests = mocks.repos[repo] ?? [];
      return {
        listManifestProperties: (options: unknown) => {
          mocks.listCalls.push({ repo, options });
          return (async function* () {
            for (const { digest, tags } of manifests) {
              yield { digest, tags };
            }
          })();
        },
        getArtifact: (digest: string) => ({
          getManifestProperties: async () => ({
            relatedArtifacts: (manifests.find(m => m.digest === digest)?.related ?? []).map(d => ({
              digest: d,
            })),
          }),
          delete: async () => {
            if (digest === mocks.failDeleteOf) throw new Error(`cannot delete ${digest}`);
            mocks.deleted.push({ repo, digest });
          },
        }),
      };
    }
  },
}));

const hex = (c: string) => c.repeat(64);
const digest = (c: string) => `sha256:${hex(c)}`;

const DEFAULT_INPUTS = {
  keep: '1',
  deleteOrphanedSignatures: 'true',
  endpoint: 'https://example.azurecr.io',
  repos: 'app',
  tenantId: 'tenant',
  secret: 'secret',
  clientId: 'client',
  audience: 'PublicCloud',
};

/** Runs the action (it starts on import) and waits until it reports a result. */
async function runAction(inputs: Record<string, string> = {}) {
  Object.assign(mocks.inputs, DEFAULT_INPUTS, inputs);
  vi.resetModules();
  await import('../src/index.js');
  await vi.waitFor(() => {
    if (!mocks.setOutput.mock.calls.length && !mocks.setFailed.mock.calls.length) {
      throw new Error('action has not finished');
    }
  });
}

const deletedDigests = (repo?: string) =>
  mocks.deleted.filter(d => repo === undefined || d.repo === repo).map(d => d.digest);

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.inputs)) delete mocks.inputs[key];
  for (const key of Object.keys(mocks.repos)) delete mocks.repos[key];
  mocks.clientArgs.length = 0;
  mocks.credentialArgs.length = 0;
  mocks.listCalls.length = 0;
  mocks.deleted.length = 0;
  mocks.failDeleteOf = undefined;
});

describe('cleanup', () => {
  it('deletes images beyond the limit and reports the count', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v3'] },
      { digest: digest('2'), tags: ['v2'] },
      { digest: digest('3'), tags: ['v1'] },
    ];

    await runAction({ keep: '1' });

    expect(deletedDigests()).toEqual([digest('2'), digest('3')]);
    expect(mocks.setOutput).toHaveBeenCalledWith('count', 2);
    expect(mocks.setFailed).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith('Deleted 2 images in app');
    expect(mocks.info).toHaveBeenCalledWith('Deleted 2 images');
  });

  it('lists manifests newest first', async () => {
    await runAction();

    expect(mocks.listCalls).toEqual([
      { repo: 'app', options: { order: 'LastUpdatedOnDescending' } },
    ]);
  });

  it('logs every deleted image with its tags', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v2'] },
      { digest: digest('2'), tags: ['old', 'older'] },
      { digest: digest('3'), tags: [] },
    ];

    await runAction({ keep: '1' });

    expect(mocks.info).toHaveBeenCalledWith(`Deleted image: ${digest('2')} - Tags: old, older`);
    expect(mocks.info).toHaveBeenCalledWith(`Deleted image: ${digest('3')} - Tags: <null>`);
  });

  it('treats manifests without a tags list as untagged', async () => {
    mocks.repos.app = [{ digest: digest('1'), tags: ['v1'] }, { digest: digest('2') }];

    await runAction({ keep: '1' });

    expect(deletedDigests()).toEqual([digest('2')]);
    expect(mocks.info).toHaveBeenCalledWith(`Deleted image: ${digest('2')} - Tags: <null>`);
  });

  it('deletes nothing and reports 0 for an empty repository', async () => {
    await runAction();

    expect(mocks.deleted).toEqual([]);
    expect(mocks.setOutput).toHaveBeenCalledWith('count', 0);
  });

  it('keeps artifacts that a kept image references', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v1'], related: [digest('2')] },
      { digest: digest('2'), tags: [] },
      { digest: digest('3'), tags: [] },
    ];

    await runAction({ keep: '1' });

    expect(deletedDigests()).toEqual([digest('3')]);
  });

  it('parses the keep input as a number', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v3'] },
      { digest: digest('2'), tags: ['v2'] },
      { digest: digest('3'), tags: ['v1'] },
    ];

    await runAction({ keep: '2' });

    expect(deletedDigests()).toEqual([digest('3')]);
  });
});

describe('signatures', () => {
  const sigTag = (c: string) => `sha256-${hex(c)}.sig`;

  it('does not let signatures use up the keep limit', async () => {
    mocks.repos.app = [
      { digest: digest('a'), tags: [sigTag('1')] },
      { digest: digest('1'), tags: ['v2'] },
      { digest: digest('b'), tags: [sigTag('2')] },
      { digest: digest('2'), tags: ['v1'] },
    ];

    await runAction({ keep: '2' });

    expect(mocks.deleted).toEqual([]);
    expect(mocks.setOutput).toHaveBeenCalledWith('count', 0);
  });

  it('deletes the signature of a deleted image', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v2'] },
      { digest: digest('2'), tags: ['v1'] },
      { digest: digest('a'), tags: [sigTag('2')] },
    ];

    await runAction({ keep: '1' });

    expect(deletedDigests()).toEqual([digest('2'), digest('a')]);
  });

  it('deletes orphaned signatures when deleteOrphanedSignatures is true', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v1'] },
      { digest: digest('a'), tags: [sigTag('9')] },
    ];

    await runAction({ deleteOrphanedSignatures: 'true' });

    expect(deletedDigests()).toEqual([digest('a')]);
  });

  it('keeps orphaned signatures when deleteOrphanedSignatures is false', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v1'] },
      { digest: digest('a'), tags: [sigTag('9')] },
    ];

    await runAction({ deleteOrphanedSignatures: 'false' });

    expect(mocks.deleted).toEqual([]);
  });
});

describe('repos', () => {
  const twoImages = (c: string, d: string): FakeManifest[] => [
    { digest: digest(c), tags: ['new'] },
    { digest: digest(d), tags: ['old'] },
  ];

  it('cleans every repo and sums up the count', async () => {
    mocks.repos.one = twoImages('1', '2');
    mocks.repos.two = twoImages('3', '4');

    await runAction({ repos: 'one two' });

    expect(deletedDigests('one')).toEqual([digest('2')]);
    expect(deletedDigests('two')).toEqual([digest('4')]);
    expect(mocks.info).toHaveBeenCalledWith('Deleted 1 images in one');
    expect(mocks.info).toHaveBeenCalledWith('Deleted 1 images in two');
    expect(mocks.setOutput).toHaveBeenCalledWith('count', 2);
  });

  it.each([
    ['comma', 'one,two'],
    ['semicolon', 'one;two'],
    ['new line', 'one\ntwo'],
    ['space', 'one two'],
    ['mixed separators and blanks', ' one , ;\n two\n'],
  ])('splits repos separated by %s', async (_name, repos) => {
    await runAction({ repos });

    expect(mocks.listCalls.map(c => c.repo)).toEqual(['one', 'two']);
  });
});

describe('client setup', () => {
  it('connects to the endpoint with the given credentials', async () => {
    await runAction({
      endpoint: 'https://my.azurecr.io',
      tenantId: 't',
      clientId: 'c',
      secret: 's',
    });

    expect(mocks.credentialArgs).toEqual([['t', 'c', 's']]);
    expect(mocks.clientArgs).toHaveLength(1);
    expect(mocks.clientArgs[0][0]).toBe('https://my.azurecr.io');
  });

  it.each([
    ['PublicCloud', 'public-audience'],
    ['China', 'china-audience'],
    ['china', 'china-audience'],
    ['Germany', 'germany-audience'],
    ['Government', 'government-audience'],
    ['something-else', 'public-audience'],
    ['', 'public-audience'],
  ])('maps the audience %j to %s', async (audience, expected) => {
    await runAction({ audience });

    expect(mocks.clientArgs[0][2]).toEqual({ audience: expected });
  });

  it('does not log the secret', async () => {
    await runAction({ secret: 'super-secret-value' });

    const logged = JSON.stringify([...mocks.debug.mock.calls, ...mocks.info.mock.calls]);
    expect(logged).not.toContain('super-secret-value');
  });
});

describe('errors', () => {
  it('fails the action if deleting an image fails and reports what was deleted before', async () => {
    mocks.repos.app = [
      { digest: digest('1'), tags: ['v3'] },
      { digest: digest('2'), tags: ['v2'] },
      { digest: digest('3'), tags: ['v1'] },
    ];
    mocks.failDeleteOf = digest('3');

    await runAction({ keep: '1' });

    expect(deletedDigests()).toEqual([digest('2')]);
    expect(mocks.setFailed).toHaveBeenCalledWith(new Error(`cannot delete ${digest('3')}`));
    expect(mocks.setOutput).not.toHaveBeenCalled();
  });

  it('counts images of already finished repos when a later repo fails', async () => {
    mocks.repos.one = [
      { digest: digest('1'), tags: ['new'] },
      { digest: digest('2'), tags: ['old'] },
    ];
    mocks.repos.two = [
      { digest: digest('3'), tags: ['new'] },
      { digest: digest('4'), tags: ['old'] },
    ];
    mocks.failDeleteOf = digest('4');

    await runAction({ repos: 'one two' });

    expect(mocks.info).toHaveBeenLastCalledWith('Deleted 1 images');
    expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  });

  it('fails the action if deleteOrphanedSignatures is not a boolean', async () => {
    await runAction({ deleteOrphanedSignatures: 'maybe' });

    expect(mocks.setFailed).toHaveBeenCalledTimes(1);
    expect(mocks.clientArgs).toEqual([]);
    expect(mocks.deleted).toEqual([]);
  });
});
