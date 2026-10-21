import { describe, expect, it } from 'vitest';
import {
  NON_ASCII_REGEX_MESSAGE,
  checkRegex,
  checkRegexSubstitution,
  toJsRegExp,
  toRegexSubstitution,
} from '../src/index.js';

// Every case below was installed as a regexFilter in Chromium 151 (scratch probe, 2026-10-21).
describe('checkRegex follows what Chrome installs', () => {
  it.each([
    '(?i)abc',
    '(?is)a.b',
    '(?i)(?s)a',
    '(?-i)Abc',
    '(?)a',
    '(?i:a)b',
    'a(?i)b',
    '(?U)a+',
    '(?P<name>x)',
    '(?<name>x)',
    '(?<1n>x)',
    '(?P<n>a)(?P<n>b)',
    '\\p{L}+',
    '\\pL',
    '\\PL',
    '\\p{^L}',
    '\\p{Greek}',
    '\\p{Lu}',
    '\\p{Any}',
    '[\\p{L}]',
    '\\z',
    'a\\z',
    '\\A',
    '\\Qa.b\\E',
    '\\Q\\',
    '[[:alpha:]]',
    '[[:^alpha:]]',
    '\\x{41}',
    '\\x41',
    '\\xe9',
    '\\x{7f}',
    '\\C',
    '\\0',
    '\\012',
    '\\12',
    '\\0123',
    '\\a',
    '\\v',
    'a{,3}',
    'a{1,2}?',
    '\\/',
    '\\-',
    '\\_',
    '\\@',
    '[a-]',
    '[\\d-z]',
    '[[:alpha:]-z]',
    '[]a]',
    '[^]a]',
    '[^\\]a]',
    '()',
    'a|',
  ])('accepts %s', (pattern) => {
    expect(checkRegex(pattern)).toBeNull();
  });

  it.each([
    ['[^]', /\[\^\] is not valid/],
    ['\\u0041', /\\u escapes/],
    ['\\cA', /Control escapes/],
    ['\\Z', /\\Z is not supported/],
    ['\\e', /\\e is not a valid escape/],
    ['\\N', /\\N is not a valid escape/],
    ['\\8', /Backreferences/],
    ['\\1', /Backreferences/],
    ['\\18', /Backreferences/],
    ['(a)\\1', /Backreferences/],
    ['\\k<n>', /Named backreferences/],
    ['(?P<n>a)(?P=n)', /Named backreferences/],
    ['a(?=b)', /Lookahead/],
    ['(?<!a)b', /Lookahead and lookbehind/],
    ['(?>a)', /Atomic/],
    ['a++', /Possessive/],
    ['a{2}+', /Possessive/],
    ['a**', /Two repetition operators/],
    ['a{2}{3}', /Two repetition operators/],
    ['*a', /needs something before it/],
    ['a{1001}', /at most 1000 repetitions/],
    ['a{2,1}', /maximum is smaller than the minimum; write \{1,2\}/],
    ['[\\b]', /cannot be used inside \[ \]/],
    ['[\\A]', /cannot be used inside/],
    ['[\\z]', /cannot be used inside/],
    ['[\\Q]\\E]', /cannot be used inside/],
    ['\\x{100}', /up to \\xFF/],
    ['\\x{1F600}', /up to \\xFF/],
    ['(?#c)', /group syntax "\(\?#"/],
    ['(?x)a', /group syntax/],
    ['(?-)a', /group syntax/],
    ['(?P<a-b>x)', /Group names/],
    ['[a-\\d]', /Invalid regular expression/],
    ['[z-a]', /Invalid regular expression: Range out of order/],
    ['a{3,2}', /maximum is smaller than the minimum; write \{2,3\}/],
    ['(', /Missing \)/],
    ['a)', /without a matching \(/],
    ['[abc', /Missing \]/],
    ['a\\', /lone \\/],
  ])('rejects %s', (pattern, reason) => {
    expect(checkRegex(pattern)).toMatch(reason);
  });

  it('rejects non-ASCII characters, which Chrome refuses although isRegexSupported allows them', () => {
    expect(checkRegex('^https://bücher\\.de/')).toBe(NON_ASCII_REGEX_MESSAGE);
    expect(checkRegex('é')).toBe(NON_ASCII_REGEX_MESSAGE);
  });

  it('no longer reads \\p{L}+ as a possessive quantifier', () => {
    expect(checkRegex('^https://x\\.test/\\p{L}+$')).toBeNull();
  });
});

describe('toJsRegExp', () => {
  const matches = (pattern: string, url: string, caseSensitive = false): boolean | null => {
    const re = toJsRegExp(pattern, caseSensitive);
    return re === null ? null : re.test(url);
  };

  it('is case-insensitive by default, like DNR', () => {
    expect(matches('^https://x\\.test/API', 'https://x.test/api')).toBe(true);
    expect(matches('^https://x\\.test/API', 'https://x.test/api', true)).toBe(false);
  });

  it('turns leading flag groups into JS flags', () => {
    expect(matches('(?i)^https://x\\.test/API', 'https://x.test/api', true)).toBe(true);
    expect(matches('(?-i)^https://x\\.test/API', 'https://x.test/api')).toBe(false);
    expect(toJsRegExp('(?is)a.b')?.flags).toBe('isu');
    expect(toJsRegExp('(?m)^a$')?.flags).toBe('imu');
  });

  it('translates named groups, \\p classes and RE2-only escapes', () => {
    expect(matches('^https://(?P<host>[a-z]+)\\.test/', 'https://abc.test/')).toBe(true);
    expect(toJsRegExp('^https://(?P<host>[a-z]+)\\.test/')?.exec('https://abc.test/')?.[1]).toBe(
      'abc',
    );
    expect(matches('^https://x\\.test/\\pL+$', 'https://x.test/abc')).toBe(true);
    expect(matches('^https://x\\.test/\\p{L}+$', 'https://x.test/a1')).toBe(false);
    expect(matches('\\Ahttps://x\\.test/\\z', 'https://x.test/')).toBe(true);
    expect(matches('\\Ahttps://x\\.test/\\z', 'xhttps://x.test/')).toBe(false);
    expect(matches('^https://x\\.test/\\Q?a=1\\E$', 'https://x.test/?a=1')).toBe(true);
    expect(matches('^https://x\\.test/\\Q?a=1\\E$', 'https://x.test/a=1')).toBe(false);
    expect(matches('^https://x\\.test/[[:digit:]]+$', 'https://x.test/123')).toBe(true);
    expect(matches('^https://x\\.test/[[:digit:]]+$', 'https://x.test/12a')).toBe(false);
    expect(matches('^https://x\\.test/a{,3}$', 'https://x.test/a{,3}')).toBe(true);
    expect(matches('^https://x\\.test/\\x41$', 'https://x.test/a')).toBe(true);
  });

  it('reads - after a set inside [ ] as a literal, as RE2 does', () => {
    expect(matches('^[\\d-z]+$', '1-z')).toBe(true);
    expect(matches('^[\\d-z]+$', 'y')).toBe(false);
    expect(matches('^[\\p{L}-]+$', 'a-b')).toBe(true);
  });

  it('keeps RE2 class semantics for a leading ]', () => {
    expect(matches('^[]a]$', ']')).toBe(true);
    expect(matches('^[^]a]$', 'b')).toBe(true);
    expect(matches('^[^]a]$', ']')).toBe(false);
  });

  it('returns null for valid RE2 that JS cannot express, and for invalid patterns', () => {
    expect(toJsRegExp('a(?i)b')).toBeNull();
    expect(toJsRegExp('(?i:a)b')).toBeNull();
    expect(toJsRegExp('(?U)a+')).toBeNull();
    expect(toJsRegExp('[[:^alpha:]]')).toBeNull();
    expect(toJsRegExp('a(?=b)')).toBeNull();
    expect(toJsRegExp('[z-a]')).toBeNull();
  });
});

describe('regex substitutions', () => {
  it('converts $n to \\n and escapes backslashes', () => {
    expect(toRegexSubstitution('http://localhost:3000/$1?x=$2')).toBe(
      'http://localhost:3000/\\1?x=\\2',
    );
    expect(toRegexSubstitution('a\\b')).toBe('a\\\\b');
  });

  it('rejects groups the pattern does not have, as Chrome does', () => {
    expect(checkRegexSubstitution('^http://(a)(b)', 'x\\2')).toBeNull();
    expect(checkRegexSubstitution('^http://(a)', 'x\\0')).toBeNull();
    expect(checkRegexSubstitution('^http://a', 'x\\0')).toBeNull();
    expect(checkRegexSubstitution('^http://(?P<n>a)', 'x\\1')).toBeNull();
    expect(checkRegexSubstitution('^http://(a)', 'x\\\\y')).toBeNull();
    expect(checkRegexSubstitution('^http://(a)(b)', 'x\\3')).toBe(
      '$3 in the target refers to group 3, but the pattern has only 2 capture groups.',
    );
    expect(checkRegexSubstitution('^http://(?:a)(b)', 'x\\2')).toBe(
      '$2 in the target refers to group 2, but the pattern has only 1 capture group.',
    );
    expect(checkRegexSubstitution('^http://a', 'x\\1')).toBe(
      '$1 in the target refers to group 1, but the pattern has no capture groups.',
    );
  });

  it('rejects backslash escapes other than \\0-\\9 and \\\\', () => {
    expect(checkRegexSubstitution('^http://(a)', 'x\\ny')).toMatch(/backslash must be followed/);
    expect(checkRegexSubstitution('^http://(a)', 'x\\')).toMatch(/backslash must be followed/);
    expect(checkRegexSubstitution('^http://(a)', 'x\\$')).toMatch(/backslash must be followed/);
  });
});
