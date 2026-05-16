import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectFileWrites,
  collectTargetPaths,
  isFileWriteTool,
} from '../lib/tool-input.mjs';

describe('tool-input helpers', () => {
  it('recognizes Write/Edit/MultiEdit file-write tools', () => {
    assert.equal(isFileWriteTool('Write'), true);
    assert.equal(isFileWriteTool('Edit'), true);
    assert.equal(isFileWriteTool('MultiEdit'), true);
    assert.equal(isFileWriteTool('Task'), false);
  });

  it('collects top-level Write content', () => {
    assert.deepEqual(
      collectFileWrites({ file_path: 'a.txt', content: 'body' }),
      [{ filePath: 'a.txt', text: 'body' }],
    );
  });

  it('collects MultiEdit entries with inherited top-level path', () => {
    assert.deepEqual(
      collectFileWrites({
        file_path: 'a.txt',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
      [
        { filePath: 'a.txt', text: '' },
        { filePath: 'a.txt', text: 'b' },
        { filePath: 'a.txt', text: 'd' },
      ],
    );
  });

  it('collects per-edit paths for multi-file shapes', () => {
    assert.deepEqual(
      collectTargetPaths({
        edits: [
          { file_path: 'a.txt', new_string: 'a' },
          { filePath: 'b.txt', newString: 'b' },
        ],
      }),
      ['a.txt', 'b.txt'],
    );
  });
});
