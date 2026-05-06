import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import type { DomainData } from '@workos-inc/node';
import { createWorkOSClient, type WorkOSCLIClient } from '../lib/workos-client.js';
import { outputJson, outputSuccess, isJsonMode, exitWithError } from '../utils/output.js';

const STATE_FILE = '.workos-seed-state.json';

interface SeedConfig {
  organizations?: Array<{ name: string; domains?: string[] }>;
  permissions?: Array<{ name: string; slug: string; description?: string }>;
  roles?: Array<{ name: string; slug: string; description?: string; permissions?: string[] }>;
  featureFlags?: Array<{
    slug: string;
    name: string;
    description?: string;
    type: 'boolean' | 'string' | 'number';
    default_value: unknown;
    enabled?: boolean;
  }>;
  config?: {
    redirect_uris?: string[];
    cors_origins?: string[];
    homepage_url?: string;
  };
}

interface SeedState {
  permissions: Array<{ slug: string }>;
  roles: Array<{ slug: string }>;
  organizations: Array<{ id: string; name: string }>;
  featureFlags: Array<{ slug: string }>;
  createdAt: string;
}

function loadState(): SeedState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<SeedState>;
    return {
      permissions: parsed.permissions ?? [],
      roles: parsed.roles ?? [],
      organizations: parsed.organizations ?? [],
      featureFlags: parsed.featureFlags ?? [],
      createdAt: parsed.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveState(state: SeedState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const DEFAULT_SEED_FILE = 'workos-seed.yml';

const SEED_TEMPLATE = `# WorkOS seed file — provision resources with \`workos seed --file=${DEFAULT_SEED_FILE}\`
# Resources are created in order: permissions → roles → organizations → config → feature flags.
# Existing resources are skipped (idempotent). Run \`workos seed --clean\` to tear down.

permissions:
  - name: Read Posts
    slug: posts:read
  - name: Write Posts
    slug: posts:write
    description: Create and edit posts

roles:
  - name: Admin
    slug: admin
    description: Full access
    permissions:
      - posts:read
      - posts:write
  - name: Viewer
    slug: viewer
    permissions:
      - posts:read

organizations:
  - name: Acme Corp
    domains:
      - acme.com

config:
  redirect_uris:
    - http://localhost:3000/auth/callback
  cors_origins:
    - http://localhost:3000
  homepage_url: http://localhost:3000

featureFlags:
  - slug: coffee-mode
    name: Coffee Mode
    description: Enables the coffee experience
    type: boolean
    default_value: false
    enabled: false
`;

export function runSeedInit(): void {
  if (existsSync(DEFAULT_SEED_FILE)) {
    if (isJsonMode()) {
      outputJson({ status: 'exists', message: `${DEFAULT_SEED_FILE} already exists`, file: DEFAULT_SEED_FILE });
    } else {
      console.log(chalk.yellow(`${DEFAULT_SEED_FILE} already exists — not overwriting.`));
    }
    return;
  }

  writeFileSync(DEFAULT_SEED_FILE, SEED_TEMPLATE);

  if (isJsonMode()) {
    outputJson({ status: 'ok', message: `Created ${DEFAULT_SEED_FILE}`, file: DEFAULT_SEED_FILE });
  } else {
    console.log(chalk.green(`Created ${DEFAULT_SEED_FILE}`));
    console.log(chalk.dim('Edit the file, then run: workos seed --file=workos-seed.yml'));
  }
}

export async function runSeed(
  options: { file?: string; clean?: boolean; init?: boolean },
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  if (options.init) {
    runSeedInit();
    return;
  }

  if (options.clean) {
    await runSeedClean(apiKey, baseUrl);
    return;
  }

  if (!options.file) {
    return exitWithError({
      code: 'missing_args',
      message:
        'Provide a seed file: workos seed --file=workos-seed.yml\nRun workos seed --init to create an example seed file.',
    });
  }

  if (!existsSync(options.file)) {
    return exitWithError({
      code: 'file_not_found',
      message: `Seed file not found: ${options.file}. Create workos-seed.yml or run \`workos seed\` without --file for interactive mode.`,
    });
  }

  const raw = readFileSync(options.file, 'utf-8');
  let seedConfig: SeedConfig;
  try {
    seedConfig = parseYaml(raw) as SeedConfig;
  } catch (error) {
    exitWithError({
      code: 'invalid_yaml',
      message: `Failed to parse seed file: ${error instanceof Error ? error.message : 'Invalid YAML'}`,
    });
  }

  const client = createWorkOSClient(apiKey, baseUrl);
  const state: SeedState = {
    permissions: [],
    roles: [],
    organizations: [],
    featureFlags: [],
    createdAt: new Date().toISOString(),
  };

  try {
    // 1. Create permissions
    if (seedConfig.permissions) {
      for (const perm of seedConfig.permissions) {
        try {
          await client.sdk.authorization.createPermission({
            slug: perm.slug,
            name: perm.name,
            ...(perm.description && { description: perm.description }),
          });
          state.permissions.push({ slug: perm.slug });
          if (!isJsonMode()) console.log(chalk.green(`  Created permission: ${perm.slug}`));
        } catch (error: unknown) {
          if (isAlreadyExists(error)) {
            if (!isJsonMode()) console.log(chalk.dim(`  Permission exists: ${perm.slug} (skipped)`));
          } else {
            throw error;
          }
        }
      }
    }

    // 2. Create roles + assign permissions
    if (seedConfig.roles) {
      for (const role of seedConfig.roles) {
        try {
          await client.sdk.authorization.createEnvironmentRole({
            slug: role.slug,
            name: role.name,
            ...(role.description && { description: role.description }),
          });
          state.roles.push({ slug: role.slug });
          if (!isJsonMode()) console.log(chalk.green(`  Created role: ${role.slug}`));
        } catch (error: unknown) {
          if (isAlreadyExists(error)) {
            if (!isJsonMode()) console.log(chalk.dim(`  Role exists: ${role.slug} (skipped)`));
          } else {
            throw error;
          }
        }

        if (role.permissions?.length) {
          try {
            await client.sdk.authorization.setEnvironmentRolePermissions(role.slug, {
              permissions: role.permissions,
            });
            if (!isJsonMode())
              console.log(chalk.green(`  Set permissions on ${role.slug}: ${role.permissions.join(', ')}`));
          } catch {
            if (!isJsonMode()) console.log(chalk.yellow(`  Warning: Failed to set permissions on ${role.slug}`));
          }
        }
      }
    }

    // 3. Create organizations
    if (seedConfig.organizations) {
      for (const org of seedConfig.organizations) {
        try {
          const created = await client.sdk.organizations.createOrganization({
            name: org.name,
            ...(org.domains?.length && {
              domainData: org.domains.map((d) => ({ domain: d, state: 'verified' as DomainData['state'] })),
            }),
          });
          state.organizations.push({ id: created.id, name: created.name });
          if (!isJsonMode()) console.log(chalk.green(`  Created org: ${created.name} (${created.id})`));
        } catch (error: unknown) {
          if (isAlreadyExists(error)) {
            if (!isJsonMode()) console.log(chalk.dim(`  Org may exist: ${org.name} (skipped)`));
          } else {
            throw error;
          }
        }
      }
    }

    // 4. Configure redirect URIs, CORS, homepage
    if (seedConfig.config) {
      await applyConfig(client, seedConfig.config);
    }

    // 5. Create feature flags
    if (seedConfig.featureFlags) {
      for (const flag of seedConfig.featureFlags) {
        try {
          await client.featureFlags.create({
            slug: flag.slug,
            name: flag.name,
            ...(flag.description && { description: flag.description }),
            type: flag.type,
            default_value: flag.default_value,
            enabled: flag.enabled ?? false,
          });
          state.featureFlags.push({ slug: flag.slug });
          if (!isJsonMode()) console.log(chalk.green(`  Created feature flag: ${flag.slug}`));
        } catch (error: unknown) {
          if (isAlreadyExists(error)) {
            if (!isJsonMode()) console.log(chalk.dim(`  Feature flag exists: ${flag.slug} (skipped)`));
          } else {
            throw error;
          }
        }
      }
    }

    saveState(state);

    if (isJsonMode()) {
      outputJson({ status: 'ok', message: 'Seed complete', state });
    } else {
      console.log(chalk.green('\nSeed complete.'));
      console.log(chalk.dim(`State saved to ${STATE_FILE}`));
    }
  } catch (error) {
    // Partial failure — save what was created so --clean can tear down
    saveState(state);
    exitWithError({
      code: 'seed_failed',
      message: `Seed failed: ${error instanceof Error ? error.message : 'Unknown error'}. Partial state saved to ${STATE_FILE}. Run \`workos seed --clean\` to tear down.`,
      details: state,
    });
  }
}

async function runSeedClean(apiKey: string, baseUrl?: string): Promise<void> {
  const state = loadState();
  if (!state) {
    return exitWithError({
      code: 'no_state',
      message: `No seed state found (${STATE_FILE}). Nothing to clean.`,
    });
  }

  const client = createWorkOSClient(apiKey, baseUrl);

  for (const flag of state.featureFlags.reverse()) {
    try {
      await client.featureFlags.delete(flag.slug);
      if (!isJsonMode()) console.log(chalk.green(`  Deleted feature flag: ${flag.slug}`));
    } catch {
      if (!isJsonMode()) console.log(chalk.yellow(`  Warning: Could not delete feature flag ${flag.slug}`));
    }
  }

  // Delete in reverse order: feature flags → orgs → roles → permissions
  for (const org of state.organizations.reverse()) {
    try {
      await client.sdk.organizations.deleteOrganization(org.id);
      if (!isJsonMode()) console.log(chalk.green(`  Deleted org: ${org.name} (${org.id})`));
    } catch {
      if (!isJsonMode()) console.log(chalk.yellow(`  Warning: Could not delete org ${org.id}`));
    }
  }

  for (const role of state.roles.reverse()) {
    try {
      // Env roles can't be deleted via SDK — skip silently
      if (!isJsonMode()) console.log(chalk.dim(`  Env role ${role.slug}: skipped (env roles cannot be deleted)`));
    } catch {
      // ignore
    }
  }

  for (const perm of state.permissions.reverse()) {
    try {
      await client.sdk.authorization.deletePermission(perm.slug);
      if (!isJsonMode()) console.log(chalk.green(`  Deleted permission: ${perm.slug}`));
    } catch {
      if (!isJsonMode()) console.log(chalk.yellow(`  Warning: Could not delete permission ${perm.slug}`));
    }
  }

  unlinkSync(STATE_FILE);
  outputSuccess('Seed cleanup complete', { stateFile: STATE_FILE });
}

async function applyConfig(client: WorkOSCLIClient, config: NonNullable<SeedConfig['config']>): Promise<void> {
  if (config.redirect_uris) {
    for (const uri of config.redirect_uris) {
      const result = await client.redirectUris.add(uri);
      if (!isJsonMode()) {
        console.log(
          result.alreadyExists
            ? chalk.dim(`  Redirect URI exists: ${uri}`)
            : chalk.green(`  Added redirect URI: ${uri}`),
        );
      }
    }
  }

  if (config.cors_origins) {
    for (const origin of config.cors_origins) {
      const result = await client.corsOrigins.add(origin);
      if (!isJsonMode()) {
        console.log(
          result.alreadyExists
            ? chalk.dim(`  CORS origin exists: ${origin}`)
            : chalk.green(`  Added CORS origin: ${origin}`),
        );
      }
    }
  }

  if (config.homepage_url) {
    await client.homepageUrl.set(config.homepage_url);
    if (!isJsonMode()) console.log(chalk.green(`  Set homepage URL: ${config.homepage_url}`));
  }
}

function isAlreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('already exists') || msg.includes('conflict') || msg.includes('duplicate');
}
