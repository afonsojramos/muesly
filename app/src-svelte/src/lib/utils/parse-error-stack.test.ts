import { describe, it, expect } from 'vitest';
import { parseStack } from './parse-error-stack';

describe('parseStack', () => {
  it('returns empty for missing stacks', () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack(null)).toEqual([]);
    expect(parseStack('')).toEqual([]);
  });

  it('parses Chromium/V8 frames and skips the message line', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at handleClick (http://localhost:1420/_app/chunks/a.js:12:9)',
      '    at http://localhost:1420/_app/chunks/b.js:3:1',
    ].join('\n');
    const frames = parseStack(stack);
    expect(frames).toEqual([
      {
        filename: 'http://localhost:1420/_app/chunks/a.js',
        function: 'handleClick',
        lineno: 12,
        colno: 9,
      },
      {
        filename: 'http://localhost:1420/_app/chunks/b.js',
        function: null,
        lineno: 3,
        colno: 1,
      },
    ]);
  });

  it('parses WebKit/JSC frames', () => {
    const stack = ['handleClick@tauri://localhost/_app/a.js:12:9', '@tauri://localhost/_app/b.js:3:1'].join(
      '\n',
    );
    const frames = parseStack(stack);
    expect(frames[0]).toEqual({
      filename: 'tauri://localhost/_app/a.js',
      function: 'handleClick',
      lineno: 12,
      colno: 9,
    });
    expect(frames[1]?.function).toBeNull();
  });

  it('caps very deep stacks', () => {
    const stack = Array.from({ length: 100 }, (_, i) => `    at fn${i} (file.js:${i}:1)`).join('\n');
    expect(parseStack(stack)).toHaveLength(30);
  });
});
