import { describe, expect, it } from 'vitest';
import { describeWhitespace, LineKind, scanLines, splitComment } from '../src/parser/lines';

describe('splitComment (port of Skript Node#splitLine)', () => {
  it('finds a comment after code', () => {
    expect(splitComment('send "hi" # greet').commentStart).toBe(10);
  });

  it('ignores # inside strings', () => {
    expect(splitComment('send "&#ff0000 red #1" to player').commentStart).toBe(-1);
  });

  it('treats ## outside strings as an escaped #', () => {
    const result = splitComment('prefix: <##f5c542>');
    expect(result.commentStart).toBe(-1);
    expect(result.unescaped).toBe('prefix: <#f5c542>');
  });

  it('keeps ## inside strings as two characters', () => {
    expect(splitComment('send "a ## b"').unescaped).toBe('send "a ## b"');
  });

  it('starts a comment at # inside a %…% part of a string, like Skript does', () => {
    expect(splitComment('send "%{_x}#%"').commentStart).toBe(11);
  });

  it('skips doubled quotes and percent signs', () => {
    expect(splitComment('send "say ""hi"" 50%%" # done').commentStart).toBe(23);
  });

  it('handles strings nested inside %…% expressions', () => {
    const line = 'send "%join {_list::*} with ", "%" # list';
    expect(splitComment(line).commentStart).toBe(line.indexOf('# list'));
  });

  it('finds an accidental comment in an unquoted option value', () => {
    expect(splitComment('accent: <#f5c542>').commentStart).toBe(9);
  });
});

describe('scanLines', () => {
  it('classifies blank, comment, block comment and code lines', () => {
    const lines = scanLines(['on join:', '', '\t# note', '###', 'not code', '###', '\tsend "hi" # x'].join('\n'));
    expect(lines.map((l) => l.kind)).toEqual([
      LineKind.Code,
      LineKind.Blank,
      LineKind.Comment,
      LineKind.BlockCommentDelimiter,
      LineKind.BlockComment,
      LineKind.BlockCommentDelimiter,
      LineKind.Code,
    ]);
  });

  it('only toggles block comments on a line that is exactly ###', () => {
    const lines = scanLines(['### not a block comment', 'on join:'].join('\n'));
    expect(lines[0].kind).toBe(LineKind.Comment);
    expect(lines[1].kind).toBe(LineKind.Code);
  });

  it('records indentation, code range and section headers', () => {
    const [line] = scanLines('\t\tif {_x} is set: # check');
    expect(line.indent).toBe('\t\t');
    expect(line.start).toBe(2);
    expect(line.end).toBe('\t\tif {_x} is set:'.length);
    expect(line.value).toBe('if {_x} is set:');
    expect(line.isSectionHeader).toBe(true);
  });

  it('does not treat a colon inside a comment as a section header', () => {
    expect(scanLines('\tsend "hi" # todo:')[0].isSectionHeader).toBe(false);
  });

  it('accepts CRLF line endings and strips a byte order mark', () => {
    const lines = scanLines('﻿on join:\r\n\tsend "hi"\r\n');
    expect(lines[0].value).toBe('on join:');
    expect(lines[1].indent).toBe('\t');
  });
});

describe('describeWhitespace', () => {
  it('matches the wording Skript uses', () => {
    expect(describeWhitespace('\t')).toBe('1 tab');
    expect(describeWhitespace('    ')).toBe('4 spaces');
    expect(describeWhitespace('\t  ')).toBe('1 tab, 2 spaces');
    expect(describeWhitespace('')).toBe('no indentation');
  });
});
