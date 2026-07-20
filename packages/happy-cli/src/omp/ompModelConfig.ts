import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type OmpConfigCommandRunner = (args: string[]) => Promise<string>;

type ModelRolesResponse = {
  value?: unknown;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

const execFileAsync = promisify(execFile);

export function createOmpConfigCommandRunner(ompBinary: string): OmpConfigCommandRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(ompBinary, args, { encoding: 'utf8' });
    return stdout;
  };
}

export async function persistOmpDefaultModel(
  modelSpec: string,
  runConfigCommand: OmpConfigCommandRunner,
): Promise<void> {
  const normalizedSpec = modelSpec.trim();
  if (!normalizedSpec) {
    throw new Error('OMP default model must not be empty');
  }

  const rawSettings = await runConfigCommand(['config', 'get', 'modelRoles', '--json']);
  const parsedSettings = JSON.parse(rawSettings) as ModelRolesResponse;
  if (!isStringRecord(parsedSettings.value)) {
    throw new Error('OMP modelRoles config is not a string record');
  }
  if (parsedSettings.value.default === normalizedSpec) {
    return;
  }

  const nextModelRoles = {
    ...parsedSettings.value,
    default: normalizedSpec,
  };
  await runConfigCommand(['config', 'set', 'modelRoles', JSON.stringify(nextModelRoles)]);
}
