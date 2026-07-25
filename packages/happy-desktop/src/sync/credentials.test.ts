import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultHappyHomeDir } from './credentials';

const originalHomeDir = process.env.HAPPY_HOME_DIR;

afterEach(() => {
  if (originalHomeDir === undefined) {
    delete process.env.HAPPY_HOME_DIR;
  } else {
    process.env.HAPPY_HOME_DIR = originalHomeDir;
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
