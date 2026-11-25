import { describe, expect, it } from 'vitest';
import { configFromEnv, type Env } from '../src/worker';
import { sqliteDb } from './support';

const base = {
  DB: sqliteDb(),
  PROXY_ACCESS_KEY_ID: 'k',
  PROXY_SECRET_ACCESS_KEY: 's',
  PROXY_BUCKET: 'b',
  GOOGLE_CLIENT_ID: 'c',
  GOOGLE_CLIENT_SECRET: 'cs',
  GOOGLE_REFRESH_TOKEN: 'r',
} satisfies Env;

describe('configFromEnv', () => {
  it('defaults the prefix to families/ and runs without upstream', () => {
    const config = configFromEnv(base);
    expect(config).toMatchObject({ drivePrefix: 'families/', upstream: null, bucket: 'b' });
  });

  it('refuses a half-configured upstream instead of silently dropping it', () => {
    const config = configFromEnv({ ...base, UPSTREAM_ENDPOINT: 'https://r2.example' });
    expect(config).toEqual({
      error: 'missing config: UPSTREAM_BUCKET, UPSTREAM_ACCESS_KEY_ID, UPSTREAM_SECRET_ACCESS_KEY',
    });
  });

  it('refuses missing Google credentials and a prefix without a slash', () => {
    expect(configFromEnv({ ...base, GOOGLE_REFRESH_TOKEN: '' })).toEqual({
      error: 'missing config: GOOGLE_REFRESH_TOKEN',
    });
    expect(configFromEnv({ ...base, DRIVE_PREFIX: 'families' })).toEqual({
      error: 'DRIVE_PREFIX must end with /',
    });
  });

  it('builds the upstream when all of it is set', () => {
    const config = configFromEnv({
      ...base,
      UPSTREAM_ENDPOINT: 'https://r2.example',
      UPSTREAM_BUCKET: 'ub',
      UPSTREAM_ACCESS_KEY_ID: 'uk',
      UPSTREAM_SECRET_ACCESS_KEY: 'us',
    });
    expect(config).toMatchObject({
      upstream: { endpoint: 'https://r2.example', bucket: 'ub', region: 'auto' },
    });
  });
});
