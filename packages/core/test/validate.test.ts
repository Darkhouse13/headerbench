import { describe, expect, it } from 'vitest';
import {
  checkColor,
  checkContentType,
  checkDomain,
  checkExactUrl,
  checkHeaderName,
  checkHeaderValue,
  checkRegex,
  checkTargetUrl,
  checkUrlFilter,
  checkVariableName,
  isAppendableRequestHeader,
  normalizeDomain,
  re2Compatible,
  re2Incompatibility,
} from '../src/index.js';

describe('header rules', () => {
  it('accepts RFC 7230 tokens only', () => {
    expect(checkHeaderName('X-Api-Key')).toBeNull();
    expect(checkHeaderName("x!#$%&'*+.^_`|~1")).toBeNull();
    expect(checkHeaderName('')).toMatch(/empty/);
    expect(checkHeaderName('Bad Name')).toMatch(/not a valid header name/);
    expect(checkHeaderName('X:Y')).not.toBeNull();
  });

  it('rejects CR, LF and NUL in values', () => {
    expect(checkHeaderValue('Bearer abc')).toBeNull();
    expect(checkHeaderValue('')).toBeNull();
    expect(checkHeaderValue('a\r\nb')).not.toBeNull();
    expect(checkHeaderValue('a\nb')).not.toBeNull();
    expect(checkHeaderValue('a\0b')).not.toBeNull();
  });

  it('knows which request headers Chrome can append to', () => {
    expect(isAppendableRequestHeader(' Accept-Language ')).toBe(true);
    expect(isAppendableRequestHeader('X-Custom')).toBe(false);
  });
});

describe('re2Compatible', () => {
  it.each([
    ['^https://api\\.example\\.com/(.*)$', true],
    ['[(?=]', true],
    ['\\(?=x\\)', true],
    ['[]a]', true],
    ['[^]a]', true],
    ['a{2,3}', true],
    ['(?:a|b)+', true],
    ['(?<name>a)', true],
    ['a(?=b)', false],
    ['a(?!b)', false],
    ['(?<=a)b', false],
    ['(?<!a)b', false],
    ['(a)\\1', false],
    ['(?<n>a)\\k<n>', false],
    ['(?>a)', false],
    ['a++', false],
    ['a*+', false],
    ['a{2}+', false],
  ])('%s → %s', (pattern, ok) => {
    expect(re2Compatible(pattern)).toBe(ok);
  });

  it('explains why', () => {
    expect(re2Incompatibility('a(?!b)')).toMatch(/Lookahead/);
    expect(re2Incompatibility('(a)\\1')).toMatch(/Backreferences/);
  });

  it('checkRegex also requires a valid JS regex', () => {
    expect(checkRegex('')).toMatch(/empty/);
    expect(checkRegex('(')).toBe('Missing ) to close a group.');
    expect(checkRegex('[z-a]')).toMatch(/^Invalid regular expression: Range out of order/);
    expect(checkRegex('^a$')).toBeNull();
  });
});

describe('urlFilter, domain and URL rules', () => {
  it('validates url filters', () => {
    expect(checkUrlFilter('||example.com^')).toBeNull();
    expect(checkUrlFilter('|https://x.test/|')).toBeNull();
    expect(checkUrlFilter('')).toMatch(/empty/);
    expect(checkUrlFilter('||*.example.com')).toMatch(/\|\|\*/);
    expect(checkUrlFilter('a|b')).toMatch(/only allowed/);
    expect(checkUrlFilter('bücher.de')).toMatch(/ASCII/);
  });

  it('normalises domains', () => {
    expect(normalizeDomain(' *.Example.COM ')).toBe('example.com');
    expect(normalizeDomain('.example.com')).toBe('example.com');
    expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeDomain('https://example.com')).toBeNull();
    expect(normalizeDomain('example.com/path')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('a..b')).toBeNull();
    expect(normalizeDomain('exa mple.com')).toBeNull();
    expect(checkDomain('localhost')).toBeNull();
    expect(checkDomain('http://x')).toMatch(/not a domain/);
  });

  it('validates redirect URLs', () => {
    expect(checkTargetUrl('http://localhost:3000/app.js')).toBeNull();
    expect(checkTargetUrl('data:text/plain,hi')).toBeNull();
    expect(checkTargetUrl('ftp://x.test/')).toMatch(/http/);
    expect(checkTargetUrl('/relative')).toMatch(/absolute/);
    expect(checkExactUrl('https://x.test/a')).toBeNull();
    expect(checkExactUrl('https://x.test/*')).toMatch(/cannot contain/);
    expect(checkExactUrl('data:text/plain,hi')).toMatch(/source/);
  });

  it('validates content types, colours and variable names', () => {
    expect(checkContentType('application/json')).toBeNull();
    expect(checkContentType('text/html; charset=utf-8')).toBeNull();
    expect(checkContentType('json')).not.toBeNull();
    expect(checkContentType('text/plain,evil')).not.toBeNull();
    expect(checkColor('#1A73E8')).toBeNull();
    expect(checkColor('blue')).not.toBeNull();
    expect(checkVariableName('api_token2')).toBeNull();
    expect(checkVariableName('2fa')).not.toBeNull();
  });
});
