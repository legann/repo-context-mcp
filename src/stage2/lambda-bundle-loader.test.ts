import { parseLambdaBundleScript } from './lambda-bundle-loader.js';

describe('parseLambdaBundleScript', () => {
  it('maps output path to TS entry when they differ', () => {
    const src = `
      const lambdaFunctions = [
        { entryPoint: 'health.ts', outputFile: 'health.js', artifactDir: 'health' },
        { entryPoint: 'platforms/monday/ingest.ts', outputFile: 'webhooks/ingest.js', artifactDir: 'x' },
        { entryPoint: 'platforms/monday/oauth-monday.ts', outputFile: 'oauth-monday.js', artifactDir: 'y' },
      ];
    `;
    const m = parseLambdaBundleScript(src);
    expect(m['webhooks/ingest']).toBe('platforms/monday/ingest');
    expect(m['oauth-monday']).toBe('platforms/monday/oauth-monday');
    expect(m['health']).toBeUndefined();
  });

  it('supports outputFile before entryPoint', () => {
    const src = `{ outputFile: 'webhooks/worker.js', entryPoint: 'platforms/monday/worker.ts' }`;
    const m = parseLambdaBundleScript(src);
    expect(m['webhooks/worker']).toBe('platforms/monday/worker');
  });
});
