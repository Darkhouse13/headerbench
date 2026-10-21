/**
 * Chrome's `regexFilter` dialect. Chrome compiles DNR regexes with RE2 in Latin-1 mode, so this
 * module accepts what Chrome 151 installs and rejects what it refuses (probed in a real
 * Chromium: `(?i)`, `(?P<n>…)`, `\p{L}`, `\Q…\E`, `[[:alpha:]]` install; `[^]`, `\uXXXX`, `\cX`,
 * `\Z`, `\x{100}` and any non-ASCII character do not).
 *
 * One pass checks a pattern, counts its capture groups and translates it into a JS RegExp with
 * the same matching behaviour, so the URL tester can simulate it. A few valid RE2 forms have no
 * JS equivalent (flags after the start, `(?U)`, negated POSIX classes); those still validate but
 * the tester reports that it cannot preview them.
 */

/** RE2's repetition limit for `{n,m}`. */
const MAX_REPEAT = 1000;

/** Characters that need a backslash to be literal in a JS `u`-mode pattern. */
const JS_SYNTAX = '^$\\.*+?()[]{}|/';

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: '\\t ',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-\\/:-@\\[-`\\{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};

const GENERAL_CATEGORIES = new Set(
  'C Cc Cf Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'.split(
    ' ',
  ),
);

export const NON_ASCII_REGEX_MESSAGE =
  'Chrome rules accept only ASCII characters. URLs are matched percent-encoded, so write é as %C3%A9.';

const LATIN1_MESSAGE =
  'Chrome rules only match characters up to \\xFF. URLs are matched percent-encoded, so match the %XX form instead.';

const LOOKAROUND_MESSAGE =
  'Lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not supported in Chrome rules.';

export interface JsTranslation {
  source: string;
  /** From a leading `(?i)` / `(?-i)`; null leaves case sensitivity to the rule. */
  ignoreCase: boolean | null;
  multiline: boolean;
  dotAll: boolean;
}

export type Re2Parse =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** Capture groups, numbered as RE2 and DNR's `regexSubstitution` count them. */
      groups: number;
      /** Null when the pattern is valid RE2 but JS cannot express it. */
      js: JsTranslation | null;
    };

class Re2Error extends Error {}

class Re2Scanner {
  private i = 0;
  private out = '';
  private depth = 0;
  private groups = 0;
  private simulatable = true;
  private canRepeat = false;
  private afterQuantifier = false;
  private ignoreCase: boolean | null = null;
  private multiline = false;
  private dotAll = false;

  constructor(private readonly p: string) {}

  run(): Re2Parse {
    this.leadingFlags();
    while (this.i < this.p.length) this.atom();
    if (this.depth > 0) this.fail('Missing ) to close a group.');
    return {
      ok: true,
      groups: this.groups,
      js: this.simulatable
        ? {
            source: this.out,
            ignoreCase: this.ignoreCase,
            multiline: this.multiline,
            dotAll: this.dotAll,
          }
        : null,
    };
  }

  private fail(message: string): never {
    throw new Re2Error(message);
  }

  private sticky(re: RegExp, at: number): RegExpExecArray | null {
    re.lastIndex = at;
    return re.exec(this.p);
  }

  /** `(?i)`, `(?s)`, `(?m)`, combinations and `(?-i)` at the very start become JS flags. */
  private leadingFlags(): void {
    for (;;) {
      const m = this.sticky(/\(\?([imsU]*)(?:-([imsU]+))?\)/y, this.i);
      if (!m) return;
      const on = m[1] ?? '';
      const off = m[2] ?? '';
      if (on.includes('U') || off.includes('U')) this.simulatable = false;
      if (on.includes('i')) this.ignoreCase = true;
      if (on.includes('m')) this.multiline = true;
      if (on.includes('s')) this.dotAll = true;
      if (off.includes('i')) this.ignoreCase = false;
      if (off.includes('m')) this.multiline = false;
      if (off.includes('s')) this.dotAll = false;
      this.i += m[0].length;
    }
  }

  private emit(text: string, repeatable: boolean): void {
    this.out += text;
    this.canRepeat = repeatable;
    this.afterQuantifier = false;
  }

  private atom(): void {
    const ch = this.p[this.i] as string;
    switch (ch) {
      case '\\':
        this.emit(this.escape(false), true);
        return;
      case '[':
        this.charClass();
        return;
      case '(':
        this.group();
        return;
      case ')':
        if (this.depth === 0) this.fail('There is a ) without a matching (.');
        this.depth--;
        this.i++;
        this.emit(')', true);
        return;
      case '|':
        this.i++;
        this.emit('|', false);
        return;
      case '*':
      case '+':
      case '?':
        this.quantifier(ch);
        return;
      case '{': {
        const m = this.sticky(/\{(\d+)(?:,(\d*))?\}/y, this.i);
        if (!m) {
          this.i++;
          this.emit('\\{', true);
          return;
        }
        const counts = [m[1], m[2]].filter((n): n is string => n !== undefined && n !== '');
        if (counts.some((n) => Number(n) > MAX_REPEAT)) {
          this.fail(`Chrome allows at most ${MAX_REPEAT} repetitions in {n,m}.`);
        }
        if (m[2] !== undefined && m[2] !== '' && Number(m[2]) < Number(m[1])) {
          this.fail(
            `In {${m[1]},${m[2]}} the maximum is smaller than the minimum; write {${m[2]},${m[1]}}.`,
          );
        }
        this.quantifier(m[0]);
        return;
      }
      case '}':
        this.i++;
        this.emit('\\}', true);
        return;
      case '.':
      case '^':
      case '$':
        this.i++;
        this.emit(ch, true);
        return;
      default:
        this.i++;
        this.emit(literal(ch, false), true);
    }
  }

  private quantifier(text: string): void {
    if (!this.canRepeat) {
      this.fail(
        this.afterQuantifier
          ? 'Two repetition operators in a row (such as a** or a{2}{3}) are not allowed in Chrome rules.'
          : 'A repetition operator (*, +, ? or {n}) needs something before it to repeat.',
      );
    }
    this.i += text.length;
    if (this.p[this.i] === '+') {
      this.fail('Possessive quantifiers (++, *+, ?+) are not supported in Chrome rules.');
    }
    let out = text;
    if (this.p[this.i] === '?') {
      out += '?';
      this.i++;
    }
    this.out += out;
    this.canRepeat = false;
    this.afterQuantifier = true;
  }

  private group(): void {
    const rest = this.p.slice(this.i, this.i + 4);
    if (!rest.startsWith('(?')) {
      this.open('(', 1, true);
      return;
    }
    if (/^\(\?(?:[=!]|<[=!])/.test(rest)) this.fail(LOOKAROUND_MESSAGE);
    if (rest.startsWith('(?>'))
      this.fail('Atomic groups ((?>...)) are not supported in Chrome rules.');
    if (rest.startsWith('(?P=')) {
      this.fail('Named backreferences ((?P=name)) are not supported in Chrome rules.');
    }
    if (rest.startsWith('(?P<') || rest.startsWith('(?<')) {
      const m = this.sticky(/\(\?P?<([A-Za-z0-9_]+)>/y, this.i);
      if (!m) this.fail('Group names may contain only letters, digits and _.');
      // Names don't change matching or the numbered \1 substitution, and JS name rules are
      // stricter than RE2's (no leading digit, no duplicates), so emit a plain capture group.
      this.open('(', m[0].length, true);
      return;
    }
    const flags = this.sticky(/\(\?([imsU]*)(?:-([imsU]+))?([):])/y, this.i);
    if (!flags) {
      this.fail(
        `Chrome rules do not support the group syntax "${rest.slice(0, 3)}". Use (?:...) for a non-capturing group.`,
      );
    }
    const plain = flags[1] === '' && flags[2] === undefined;
    if (flags[3] === ')') {
      // Flags in the middle of a pattern: valid RE2, but JS has no inline flag switch.
      this.simulatable = false;
      this.i += flags[0].length;
      return;
    }
    if (!plain) this.simulatable = false;
    this.open('(?:', flags[0].length, false);
  }

  private open(text: string, length: number, capturing: boolean): void {
    if (capturing) this.groups++;
    this.depth++;
    this.i += length;
    this.emit(text, false);
  }

  private charClass(): void {
    const start = this.i;
    this.i++;
    let out = '[';
    if (this.p[this.i] === '^') {
      out += '^';
      this.i++;
    }
    let first = true;
    // RE2 reads `-` after a set such as \d or [:alpha:] as a literal; JS u-mode needs \- there.
    let afterSet = false;
    for (;;) {
      if (this.i >= this.p.length) {
        this.fail(
          this.p.startsWith('[^]', start)
            ? '[^] is not valid in Chrome rules. Use [\\s\\S] to match any character.'
            : 'Missing ] to close a character class.',
        );
      }
      const c = this.p[this.i] as string;
      if (c === ']' && !first) {
        this.i++;
        break;
      }
      first = false;
      if (c === '[' && this.p[this.i + 1] === ':') {
        const m = this.sticky(/\[:(\^?)([a-z]+):\]/y, this.i);
        if (m) {
          const range = POSIX_CLASSES[m[2] as string];
          if (range === undefined) this.fail(`[:${m[2]}:] is not a character class Chrome knows.`);
          if (m[1] === '^') this.simulatable = false;
          else out += range;
          this.i += m[0].length;
          afterSet = true;
          continue;
        }
      }
      if (c === '\\') {
        const escaped = this.escape(true);
        out += escaped;
        afterSet = /^\\[dDwWsSpP]/.test(escaped);
      } else {
        out += c === '-' ? (afterSet ? '\\-' : '-') : literal(c, true);
        afterSet = false;
        this.i++;
      }
    }
    this.emit(`${out}]`, true);
  }

  /** Reads the escape at `this.i` and returns its JS form. */
  private escape(inClass: boolean): string {
    const c = this.p[this.i + 1];
    if (c === undefined) {
      this.fail('The pattern ends with a lone \\. Write \\\\ for a literal backslash.');
    }
    this.i += 2;
    if (/[0-9]/.test(c)) return this.octal(c);
    switch (c) {
      case 'x':
        return this.hex();
      case 'p':
      case 'P':
        return this.property(c === 'P', inClass);
      case 'd':
      case 'D':
      case 'w':
      case 'W':
      case 's':
      case 'S':
      case 't':
      case 'n':
      case 'r':
      case 'f':
      case 'v':
        return `\\${c}`;
      case 'a':
        return '\\x07';
      case 'u':
        return this.fail(
          '\\u escapes are not supported in Chrome rules. Use \\xHH for an ASCII character.',
        );
      case 'c':
        return this.fail('Control escapes (\\cX) are not supported in Chrome rules. Use \\xHH.');
      case 'Z':
        return this.fail(
          '\\Z is not supported in Chrome rules. Use \\z or $ for the end of the URL.',
        );
      case 'k':
        return this.fail('Named backreferences (\\k<name>) are not supported in Chrome rules.');
    }
    if (inClass && /[bBAzCQ]/.test(c)) return this.fail(`\\${c} cannot be used inside [ ].`);
    switch (c) {
      case 'b':
      case 'B':
        return `\\${c}`;
      case 'A':
        return '(?<![\\s\\S])';
      case 'z':
        return '(?![\\s\\S])';
      case 'C':
        return '[\\s\\S]';
      case 'Q':
        return this.quoted();
    }
    if (/[A-Za-z]/.test(c)) return this.fail(`\\${c} is not a valid escape in Chrome rules.`);
    return literal(c, inClass);
  }

  /** `\0`, `\012`, `\12` are octal codes; `\1`–`\9` alone are backreferences, which RE2 lacks. */
  private octal(first: string): string {
    if (first !== '0' && !/[0-7]/.test(this.p[this.i] ?? '')) {
      this.fail('Backreferences (\\1) are not supported in Chrome rules.');
    }
    if (first === '8' || first === '9') {
      this.fail('Backreferences (\\1) are not supported in Chrome rules.');
    }
    let digits = first;
    while (digits.length < 3 && /[0-7]/.test(this.p[this.i] ?? '')) {
      digits += this.p[this.i];
      this.i++;
    }
    return this.codePoint(parseInt(digits, 8));
  }

  private hex(): string {
    const m = this.sticky(/\{([0-9A-Fa-f]+)\}|([0-9A-Fa-f]{2})/y, this.i);
    if (!m) this.fail('\\x must be followed by two hex digits or by {hex digits}.');
    this.i += m[0].length;
    return this.codePoint(parseInt((m[1] ?? m[2]) as string, 16));
  }

  private property(negated: boolean, inClass: boolean): string {
    const m = this.sticky(/\{(\^?)([A-Za-z_]+)\}|([A-Za-z])/y, this.i);
    if (!m) this.fail('\\p must be followed by a property name, such as \\p{L} or \\pN.');
    this.i += m[0].length;
    const name = (m[2] ?? m[3]) as string;
    const negate = negated !== (m[1] === '^');
    if (name === 'Any') {
      if (!inClass) return negate ? '[^\\s\\S]' : '[\\s\\S]';
      if (negate) this.simulatable = false;
      return negate ? '' : '\\s\\S';
    }
    const js = GENERAL_CATEGORIES.has(name) ? name : `Script=${name}`;
    return `\\${negate ? 'P' : 'p'}{${js}}`;
  }

  private codePoint(value: number): string {
    if (value > 0xff) this.fail(LATIN1_MESSAGE);
    return `\\u{${value.toString(16)}}`;
  }

  /** `\Q…\E`: everything up to `\E` (or the end) is literal. */
  private quoted(): string {
    const end = this.p.indexOf('\\E', this.i);
    const text = this.p.slice(this.i, end === -1 ? this.p.length : end);
    this.i = end === -1 ? this.p.length : end + 2;
    return [...text].map((ch) => literal(ch, false)).join('');
  }
}

function literal(ch: string, inClass: boolean): string {
  return JS_SYNTAX.includes(ch) || (inClass && ch === '-') ? `\\${ch}` : ch;
}

/** Checks `pattern` against Chrome's RE2 dialect and translates it for JS. */
export function parseRe2(pattern: string): Re2Parse {
  if ([...pattern].some((ch) => ch.charCodeAt(0) > 0x7f)) {
    return { ok: false, reason: NON_ASCII_REGEX_MESSAGE };
  }
  try {
    return new Re2Scanner(pattern).run();
  } catch (err) {
    if (err instanceof Re2Error) return { ok: false, reason: err.message };
    throw err;
  }
}

/** Why Chrome would refuse `pattern` as a regexFilter, or null. Syntax only: JS-level checks are in `checkRegex`. */
export function re2Incompatibility(pattern: string): string | null {
  const parsed = parseRe2(pattern);
  return parsed.ok ? null : parsed.reason;
}

export function re2Compatible(pattern: string): boolean {
  return re2Incompatibility(pattern) === null;
}

function jsFlags(js: JsTranslation, caseSensitive: boolean): string {
  const ignoreCase = js.ignoreCase ?? !caseSensitive;
  return `u${ignoreCase ? 'i' : ''}${js.multiline ? 'm' : ''}${js.dotAll ? 's' : ''}`;
}

/**
 * A JS RegExp that matches like Chrome's regexFilter (case-insensitive unless `caseSensitive`,
 * DNR's default). Null when the pattern is invalid or uses RE2 features JS cannot express.
 */
export function toJsRegExp(pattern: string, caseSensitive = false): RegExp | null {
  const parsed = parseRe2(pattern);
  if (!parsed.ok || parsed.js === null) return null;
  try {
    return new RegExp(parsed.js.source, jsFlags(parsed.js, caseSensitive));
  } catch {
    return null;
  }
}

/** A regexFilter Chrome would install: non-empty, RE2-compatible and well-formed. */
export function checkRegex(pattern: string): string | null {
  if (pattern.length === 0) return 'Pattern is empty.';
  const parsed = parseRe2(pattern);
  if (!parsed.ok) return parsed.reason;
  if (parsed.js === null) return null;
  try {
    new RegExp(parsed.js.source, jsFlags(parsed.js, false));
    return null;
  } catch (err) {
    const detail = (err as Error).message.replace(
      /^Invalid regular expression: \/.*\/[a-z]*: /s,
      '',
    );
    return `Invalid regular expression: ${detail}.`;
  }
}

/** `$1` → `\1` for DNR regexSubstitution; a literal backslash is escaped. */
export function toRegexSubstitution(target: string): string {
  return target.replace(/\\/g, '\\\\').replace(/\$(\d)/g, '\\$1');
}

/**
 * Checks a DNR regexSubstitution against its pattern: Chrome refuses the rule when `\N` names a
 * group the pattern does not have, or when a backslash is followed by anything but a digit or `\`.
 * Messages use the `$N` form people type in the redirect target.
 */
export function checkRegexSubstitution(pattern: string, substitution: string): string | null {
  const parsed = parseRe2(pattern);
  if (!parsed.ok) return null;
  for (let i = 0; i < substitution.length; i++) {
    if (substitution[i] !== '\\') continue;
    const next = substitution[i + 1] ?? '';
    i++;
    if (next === '\\') continue;
    if (!/[0-9]/.test(next)) {
      return 'In a regex redirect target, a backslash must be followed by a group number or another backslash.';
    }
    const n = Number(next);
    if (n > parsed.groups) {
      const has =
        parsed.groups === 0
          ? 'the pattern has no capture groups'
          : `the pattern has only ${parsed.groups} capture ${parsed.groups === 1 ? 'group' : 'groups'}`;
      return `$${n} in the target refers to group ${n}, but ${has}.`;
    }
  }
  return null;
}
