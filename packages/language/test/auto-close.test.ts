import { describe, expect, test } from 'vitest';
import { getSpecificationLinkAutoDeleteRange } from '../src/thinai-auto-close.js';

describe('specification link auto delete', () => {
    test('removes one closer when backspacing the second opener', () => {
        expect(getSpecificationLinkAutoDeleteRange('[[]]', '[]]', 1, 1, '')).toEqual({
            start: 1,
            end: 2
        });
    });

    test('removes both closers when both openers are deleted', () => {
        expect(getSpecificationLinkAutoDeleteRange('[[]]', ']]', 0, 2, '')).toEqual({
            start: 0,
            end: 2
        });
    });

    test('removes the remaining closer after the first pair is removed', () => {
        expect(getSpecificationLinkAutoDeleteRange('[]', ']', 0, 1, '')).toEqual({
            start: 0,
            end: 1
        });
    });

    test('removes the remaining closer when only one is left', () => {
        expect(getSpecificationLinkAutoDeleteRange('[[', ']', 0, 2, '')).toEqual({
            start: 0,
            end: 1
        });
    });

    test('removes both closers when openers are deleted before an empty link', () => {
        expect(getSpecificationLinkAutoDeleteRange('Use [[', 'Use ]]', 4, 2, '')).toEqual({
            start: 4,
            end: 6
        });
    });

    test('ignores insertions and deletions without a closer', () => {
        expect(getSpecificationLinkAutoDeleteRange('abc', 'abcd', 3, 0, 'd')).toBeUndefined();
        expect(getSpecificationLinkAutoDeleteRange('[[]]', '[]]', 1, 1, 'x')).toBeUndefined();
        expect(getSpecificationLinkAutoDeleteRange('abc', 'bc', 0, 1, '')).toBeUndefined();
        expect(getSpecificationLinkAutoDeleteRange('a[]]', 'a]]', 1, 1, '')).toEqual({
            start: 1,
            end: 2
        });
        expect(getSpecificationLinkAutoDeleteRange('[[abc]]', 'abc]]', 0, 2, '')).toBeUndefined();
    });
});
