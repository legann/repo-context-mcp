import { extractSemanticForUi } from './ui-semantic-extract.js';

describe('extractSemanticForUi', () => {
  it('returns undefined for empty semantic', () => {
    expect(extractSemanticForUi(undefined)).toBeUndefined();
    expect(extractSemanticForUi({ summary: 'only summary' })).toBeUndefined();
  });

  it('picks flow and lists', () => {
    const r = extractSemanticForUi({
      summary: 'x',
      flowDescription: '  step A → B  ',
      assumptions: ['a1'],
      risks: ['r1'],
    });
    expect(r).toEqual({
      flowDescription: 'step A → B',
      assumptions: ['a1'],
      risks: ['r1'],
    });
  });

  it('trims keyExports', () => {
    const ke: Record<string, string> = {};
    for (let i = 0; i < 30; i++) ke[`k${i}`] = `v${i}`;
    const r = extractSemanticForUi({ summary: 's', keyExports: ke });
    expect(r?.keyExports).toBeDefined();
    expect(Object.keys(r!.keyExports!)).toHaveLength(24);
  });
});
