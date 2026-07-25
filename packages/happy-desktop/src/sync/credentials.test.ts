import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHappyHomeDir, loadAccountSecret } from './credentials';

const originalHomeDir = process.env.HAPPY_HOME_DIR;
let temporaryHome: string | null = null;

afterEach(async () => {
  if (originalHomeDir === undefined) {
    delete process.env.HAPPY_HOME_DIR;
  } else {
    process.env.HAPPY_HOME_DIR = originalHomeDir;
  }
  if (temporaryHome) {
    await rm(temporaryHome, { recursive: true, force: true });
    temporaryHome = null;
  }
});

describe('defaultHappyHomeDir', () => {
  it('defaults the desktop to the OMP Happy identity', () => {
    delete process.env.HAPPY_HOME_DIR;
    expect(defaultHappyHomeDir()).toBe(join(homedir(), '.omp-happy'));
  });

  it('honors an explicit Happy home override', () => {
    process.env.HAPPY_HOME_DIR = '/tmp/custom-happy-home';
    expect(defaultHappyHomeDir()).toBe('/tmp/custom-happy-home');
  });
});

describe('loadAccountSecret', () => {
  it('reads the Happy Agent account secret from the co-located agent.key', async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), 'happy-desktop-credentials-'));
    const secret = new Uint8Array(32).fill(7);
    await writeFile(join(temporaryHome, 'agent.key'), JSON.stringify({
      token: 'agent-token',
      secret: Buffer.from(secret).toString('base64'),
    }));

    expect(await loadAccountSecret(temporaryHome)).toEqual(secret);
  });

  it('treats missing or malformed agent credentials as unavailable', async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), 'happy-desktop-credentials-'));
    expect(await loadAccountSecret(temporaryHome)).toBeNull();

    await writeFile(join(temporaryHome, 'agent.key'), JSON.stringify({
      token: 'agent-token',
      secret: Buffer.from(new Uint8Array(16)).toString('base64'),
    }));
    expect(await loadAccountSecret(temporaryHome)).toBeNull();

    await writeFile(join(temporaryHome, 'agent.key'), '{not json');
    expect(await loadAccountSecret(temporaryHome)).toBeNull();
  });
});