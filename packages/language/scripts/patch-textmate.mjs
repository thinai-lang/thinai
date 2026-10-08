import { readFile, writeFile } from 'node:fs/promises';

const grammarPath = new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url);
const original = await readFile(grammarPath, 'utf8');
const grammar = JSON.parse(original);

if (!grammar.patterns || !grammar.repository) {
    throw new Error('Generated Thinai TextMate grammar has an unexpected structure.');
}

grammar.patterns = grammar.patterns.filter(pattern => !pattern.name?.startsWith('string.quoted.'));
const strings = [
    {
        name: 'string.quoted.double.thinai',
        applyEndPatternLast: true,
        begin: '"',
        beginCaptures: { '0': { name: 'punctuation.definition.string.begin.thinai' } },
        end: '"',
        endCaptures: { '0': { name: 'punctuation.definition.string.end.thinai' } },
        patterns: [
            { include: '#linked-reference' },
            { include: '#string-character-escape' }
        ]
    },
    {
        name: 'string.quoted.single.thinai',
        applyEndPatternLast: true,
        begin: "'",
        beginCaptures: { '0': { name: 'punctuation.definition.string.begin.thinai' } },
        end: "'",
        endCaptures: { '0': { name: 'punctuation.definition.string.end.thinai' } },
        patterns: [
            { include: '#linked-reference' },
            { include: '#string-character-escape' }
        ]
    }
];
const commentPatternIndex = grammar.patterns.findIndex(pattern => pattern.include === '#comments');
grammar.patterns.splice(commentPatternIndex + 1, 0, ...strings);

grammar.repository['linked-reference'] = {
    name: 'meta.reference.thinai',
    begin: '(?<!\\\\)((?:\\\\\\\\)*(\\[\\[))',
    beginCaptures: {
        '1': { name: 'constant.character.escape.thinai' },
        '2': { name: 'punctuation.section.reference.begin.thinai' }
    },
    end: '\\]\\]',
    endCaptures: { '0': { name: 'punctuation.section.reference.end.thinai' } },
    patterns: [
        {
            name: 'variable.other.reference.thinai',
            match: '[_a-zA-Z][\\w_]*(?:\\.[_a-zA-Z][\\w_]*)*'
        }
    ]
};

grammar.repository['string-character-escape'] = {
    name: 'constant.character.escape.thinai',
    match: '\\\\.'
};

const output = `${JSON.stringify(grammar, null, 2)}\n`;
if (output !== original) {
    await writeFile(grammarPath, output);
}
