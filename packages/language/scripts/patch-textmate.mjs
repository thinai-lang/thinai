import { readFile, writeFile } from 'node:fs/promises';

const grammarPath = new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url);
const original = await readFile(grammarPath, 'utf8');
const grammar = JSON.parse(original);

// Keep TextMate identifier lexing aligned with the grammar's `ID` terminal:
// a plain identifier or a backtick-delimited name that may contain spaces and
// hyphens. The boundary avoids partially scoping plain identifiers.
const identifierSource = '(?:[_a-zA-Z][\\w_]*|`[a-zA-Z0-9_ -]+`)';
const identifierPattern = `(?<![\\w\`])${identifierSource}(?![\\w\`])`;
const qualifiedIdentifierSource = `${identifierSource}(?:\\.${identifierSource})*`;

if (!grammar.patterns || !grammar.repository) {
    throw new Error('Generated Thinai TextMate grammar has an unexpected structure.');
}

grammar.patterns = grammar.patterns.filter(pattern => !pattern.name?.startsWith('string.quoted.'));
const strings = [
    {
        name: 'string.quoted.triple.double.thinai',
        applyEndPatternLast: true,
        begin: '"""',
        beginCaptures: { '0': { name: 'punctuation.definition.string.begin.thinai' } },
        end: '"""',
        endCaptures: { '0': { name: 'punctuation.definition.string.end.thinai' } },
        patterns: [
            { include: '#linked-reference' },
            { include: '#string-character-escape' }
        ]
    },
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
            match: qualifiedIdentifierSource
        }
    ]
};

grammar.repository['string-character-escape'] = {
    name: 'constant.character.escape.thinai',
    match: '\\\\.'
};

const scopedDeclarations = [
    { words: ['bounded', 'context'], scope: 'entity.name.namespace.thinai' },
    { words: ['shared', 'kernel'], scope: 'entity.name.namespace.thinai' },
    { words: ['context', 'map'], scope: 'entity.name.namespace.thinai' },
    { words: ['subdomain'], scope: 'entity.name.namespace.thinai' },
    { words: ['module'], scope: 'entity.name.namespace.thinai' },
    { words: ['application', 'service'], scope: 'entity.name.class.thinai' },
    { words: ['domain', 'service'], scope: 'entity.name.class.thinai' },
    { words: ['query', 'service'], scope: 'entity.name.class.thinai' },
    { words: ['query', 'repository'], scope: 'entity.name.interface.thinai' },
    { words: ['root', 'entity'], scope: 'entity.name.class.thinai' },
    { words: ['value', 'object'], scope: 'entity.name.type.thinai' },
    { words: ['data', 'object'], scope: 'entity.name.type.thinai' },
    { words: ['read', 'model'], scope: 'entity.name.type.thinai' },
    { words: ['integration', 'event'], scope: 'entity.name.type.thinai' },
    { words: ['aggregate'], scope: 'entity.name.class.thinai' },
    { words: ['entity'], scope: 'entity.name.class.thinai' },
    { words: ['event'], scope: 'entity.name.type.thinai' },
    { words: ['repository'], scope: 'entity.name.interface.thinai' },
    { words: ['projector'], scope: 'entity.name.class.thinai' },
    { words: ['factory'], scope: 'entity.name.class.thinai' },
    { words: ['method'], scope: 'entity.name.function.thinai' },
    { words: ['journey'], scope: 'entity.name.function.thinai' },
    { words: ['actor'], scope: 'entity.name.variable.thinai' }
];

const scopedNamePatterns = scopedDeclarations.map(({ words, scope }) => {
    const captures = Object.fromEntries(words.map((_, index) => [
        String(index + 1), { name: 'keyword.control.thinai' }
    ]));
    captures[String(words.length + 1)] = { name: scope };
    const phrase = words.map(word => `(${word})`).join('\\s+');
    return {
        name: 'meta.declaration.thinai',
        match: `\\b${phrase}\\s+(${identifierPattern})`,
        captures
    };
});

const enumDeclaration = {
    name: 'meta.enum.thinai',
    begin: `\\b(enum)\\s+(${identifierPattern})\\s*(\\{)`,
    beginCaptures: {
        '1': { name: 'keyword.control.thinai' },
        '2': { name: 'entity.name.type.thinai' },
        '3': { name: 'punctuation.section.block.begin.thinai' }
    },
    end: '\\}',
    endCaptures: { '0': { name: 'punctuation.section.block.end.thinai' } },
    patterns: [
        { include: '#comments' },
        { name: 'constant.other.enum-member.thinai', match: identifierPattern },
        { name: 'punctuation.separator.comma.thinai', match: ',' }
    ]
};

const additionalScopes = [
    enumDeclaration,
    { name: 'storage.type.thinai', match: '\\b(?:string|number|boolean|date|time|instant|List|Set|Map)\\b' },
    { name: 'constant.language.thinai', match: '\\b(?:core|supporting|generic)\\b' },
    { name: 'keyword.operator.relationship.thinai', match: '<->|->|-x-' },
    {
        name: 'meta.field.optional.thinai',
        match: `(${identifierPattern})(\\?)(?=\\s*:)`,
        captures: {
            '1': { name: 'variable.other.property.thinai' },
            '2': { name: 'keyword.operator.optional.thinai' }
        }
    },
    { name: 'variable.other.property.thinai', match: `${identifierPattern}(?=\\s*:)` }
];

grammar.patterns = grammar.patterns.filter(pattern => pattern.name !== 'meta.declaration.thinai');
const keywordPatternIndex = grammar.patterns.findIndex(pattern => pattern.name === 'keyword.control.thinai');
if (keywordPatternIndex < 0) {
    throw new Error('Generated Thinai TextMate grammar is missing its keyword pattern.');
}
grammar.patterns.splice(keywordPatternIndex, 0, ...scopedNamePatterns, ...additionalScopes);

const output = `${JSON.stringify(grammar, null, 2)}\n`;
if (output !== original) {
    await writeFile(grammarPath, output);
}
