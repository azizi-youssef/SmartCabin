import { describe, expect, it } from 'vitest';

import ar from '../../messages/ar.json';
import fr from '../../messages/fr.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

/** Placeholder and tag names used in an ICU message ({name}, {count, plural…}, <tag>). */
function tokens(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*[,}]/g)) if (m[1]) names.add(m[1]);
  for (const m of message.matchAll(/<([a-zA-Z0-9_]+)>/g)) if (m[1]) names.add(`<${m[1]}>`);
  return [...names].sort();
}

const frFlat = flatten(fr as Tree);
const arFlat = flatten(ar as Tree);

describe('translation dictionaries', () => {
  it('have exactly the same keys in French and Arabic', () => {
    expect(Object.keys(arFlat).sort()).toEqual(Object.keys(frFlat).sort());
  });

  it('use the same placeholders in both languages', () => {
    for (const key of Object.keys(frFlat)) {
      expect(tokens(arFlat[key] ?? ''), key).toEqual(tokens(frFlat[key] ?? ''));
    }
  });

  it('contain no empty message', () => {
    for (const [key, value] of [...Object.entries(frFlat), ...Object.entries(arFlat)]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('actually translate the Arabic dictionary (Arabic script in most messages)', () => {
    const arabic = Object.values(arFlat).filter((v) => /[؀-ۿ]/.test(v)).length;
    expect(arabic / Object.keys(arFlat).length).toBeGreaterThan(0.9);
  });
});
