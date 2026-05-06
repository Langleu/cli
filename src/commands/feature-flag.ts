import chalk from 'chalk';
import { createWorkOSClient } from '../lib/workos-client.js';
import { formatTable } from '../utils/table.js';
import { outputSuccess, outputJson, isJsonMode, exitWithError } from '../utils/output.js';
import { createApiErrorHandler } from '../lib/api-error-handler.js';

const handleApiError = createApiErrorHandler('FeatureFlag');

export type FeatureFlagType = 'boolean' | 'string' | 'number';

export interface FeatureFlagCreateOptions {
  slug?: string;
  name?: string;
  description?: string;
  type?: FeatureFlagType;
  defaultValue?: string | number | boolean;
  enabled?: boolean;
}

export interface FeatureFlagListOptions {
  limit?: number;
  before?: string;
  after?: string;
  order?: string;
}

export async function runFeatureFlagList(
  options: FeatureFlagListOptions,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const client = createWorkOSClient(apiKey, baseUrl);

  try {
    const result = await client.sdk.featureFlags.listFeatureFlags({
      limit: options.limit,
      before: options.before,
      after: options.after,
      order: options.order as 'asc' | 'desc' | undefined,
    });

    if (isJsonMode()) {
      outputJson({ data: result.data, listMetadata: result.listMetadata });
      return;
    }

    if (result.data.length === 0) {
      console.log('No feature flags found.');
      return;
    }

    const rows = result.data.map((flag) => [
      flag.slug,
      flag.name ?? chalk.dim('-'),
      flag.enabled ? chalk.green('Yes') : chalk.red('No'),
      flag.description ?? chalk.dim('-'),
    ]);

    console.log(
      formatTable([{ header: 'Slug' }, { header: 'Name' }, { header: 'Enabled' }, { header: 'Description' }], rows),
    );

    const { before, after } = result.listMetadata;
    if (before && after) {
      console.log(chalk.dim(`Before: ${before}  After: ${after}`));
    } else if (before) {
      console.log(chalk.dim(`Before: ${before}`));
    } else if (after) {
      console.log(chalk.dim(`After: ${after}`));
    }
  } catch (error) {
    handleApiError(error);
  }
}

function parseDefaultValue(type: FeatureFlagType, value: string | number | boolean): string | number | boolean {
  if (typeof value !== 'string') return value;
  if (type === 'string') return value;

  try {
    return JSON.parse(value) as string | number | boolean;
  } catch {
    return value;
  }
}

export async function runFeatureFlagCreate(
  options: FeatureFlagCreateOptions,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const slug = options.slug?.trim();
  const name = options.name?.trim();

  if (!slug || !name || !options.type || options.defaultValue === undefined) {
    return exitWithError({
      code: 'missing_args',
      message: 'Provide --slug, --name, --type, and --default-value to create a feature flag.',
    });
  }

  const client = createWorkOSClient(apiKey, baseUrl);
  const defaultValue = parseDefaultValue(options.type, options.defaultValue);

  try {
    const result = await client.featureFlags.create({
      slug,
      name,
      ...(options.description !== undefined && { description: options.description }),
      type: options.type,
      default_value: defaultValue,
      enabled: options.enabled ?? false,
    });

    outputSuccess('Created feature flag', result);
  } catch (error) {
    handleApiError(error);
  }
}

export async function runFeatureFlagGet(slug: string, apiKey: string, baseUrl?: string): Promise<void> {
  const client = createWorkOSClient(apiKey, baseUrl);

  try {
    const result = await client.sdk.featureFlags.getFeatureFlag(slug);
    outputJson(result);
  } catch (error) {
    handleApiError(error);
  }
}

export async function runFeatureFlagEnable(slug: string, apiKey: string, baseUrl?: string): Promise<void> {
  const client = createWorkOSClient(apiKey, baseUrl);

  try {
    const result = await client.sdk.featureFlags.enableFeatureFlag(slug);
    outputSuccess('Enabled feature flag', result);
  } catch (error) {
    handleApiError(error);
  }
}

export async function runFeatureFlagDisable(slug: string, apiKey: string, baseUrl?: string): Promise<void> {
  const client = createWorkOSClient(apiKey, baseUrl);

  try {
    const result = await client.sdk.featureFlags.disableFeatureFlag(slug);
    outputSuccess('Disabled feature flag', result);
  } catch (error) {
    handleApiError(error);
  }
}

export async function runFeatureFlagAddTarget(
  slug: string,
  targetId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const client = createWorkOSClient(apiKey, baseUrl);

  try {
    await client.sdk.featureFlags.addFlagTarget({ slug, targetId });
    outputSuccess('Added target to feature flag', { slug, targetId });
  } catch (error) {
    handleApiError(error);
  }
}

export async function runFeatureFlagRemoveTarget(
  slug: string,
  targetId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const client = createWorkOSClient(apiKey, baseUrl);

  try {
    await client.sdk.featureFlags.removeFlagTarget({ slug, targetId });
    outputSuccess('Removed target from feature flag', { slug, targetId });
  } catch (error) {
    handleApiError(error);
  }
}
