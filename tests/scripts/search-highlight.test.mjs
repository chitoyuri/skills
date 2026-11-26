import { describe, expect, it } from 'vitest';

import { splitSearchMatches } from '../../site/src/lib/search-highlight.ts';

describe('splitSearchMatches', () => {
  it('marks every search term while preserving surrounding text', () => {
    expect(splitSearchMatches('Ponytail tools for search', ['pony', 'search'])).toEqual([
      { text: 'Pony', matched: true },
      { text: 'tail tools for ', matched: false },
      { text: 'search', matched: true },
    ]);
  });

  it('treats regex punctuation as literal text and prefers longer overlapping terms', () => {
    expect(splitSearchMatches('C++ (fast)', ['+', 'C++', '('])).toEqual([
      { text: 'C++', matched: true },
      { text: ' ', matched: false },
      { text: '(', matched: true },
      { text: 'fast)', matched: false },
    ]);
  });

  it('returns plain text when there are no matching terms', () => {
    expect(splitSearchMatches('没有命中', ['absent'])).toEqual([
      { text: '没有命中', matched: false },
    ]);
    expect(splitSearchMatches('保持原样', [])).toEqual([
      { text: '保持原样', matched: false },
    ]);
  });
});
