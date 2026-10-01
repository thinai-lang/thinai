import { readFile, writeFile } from 'node:fs/promises';

const grammarPath = new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url);
const original = await readFile(grammarPath, 'utf8');
const grammar = JSON.parse(original);
const interpolationPattern = {
    name: 'meta.interpolation.thinai',
    begin: '(?<!\\\\)((?:\\\\\\\\)*)(\\$\\{)',
    beginCaptures: {
        '1': { name: 'constant.character.escape.thinai' },
        '2': { name: 'punctuation.section.interpolation.begin.thinai' }
    },
    end: '\\}',
    endCaptures: {
        '0': { name: 'punctuation.section.interpolation.end.thinai' }
    },
    patterns: [
        {
            name: 'variable.other.reference.thinai',
            match: '[_a-zA-Z][\\w_]*(?:\\.[_a-zA-Z][\\w_]*)*'
        }
    ]
};

if (!grammar.patterns || !grammar.repository || !grammar.repository['string-character-escape']) {
    throw new Error('Generated Thinai TextMate grammar has an unexpected structure.');
}

grammar.patterns = grammar.patterns.filter(pattern =>
    pattern.begin !== '\\$"' && pattern.begin !== "\\$'"
);
delete grammar.repository['template-interpolation'];

const stringPatterns = grammar.patterns.filter(pattern => pattern.name?.startsWith('string.quoted.'));
if (stringPatterns.length !== 2) {
    throw new Error('Expected double- and single-quoted string patterns in generated grammar.');
}

for (const delimiter of ['double', 'single']) {
    const existing = grammar.patterns.find(pattern => pattern.name === `string.quoted.${delimiter}.thinai`);
    if (!existing) {
        throw new Error(`Generated Thinai TextMate grammar is missing the ${delimiter}-quoted string rule.`);
    }

    const quote = delimiter === 'double' ? '"' : "'";
    const templatePattern = {
        name: `string.quoted.${delimiter}.thinai`,
        begin: `\\$${quote}`,
        beginCaptures: {
            '0': { name: 'punctuation.definition.string.begin.thinai' }
        },
        end: quote,
        endCaptures: {
            '0': { name: 'punctuation.definition.string.end.thinai' }
        },
        patterns: [
            { include: '#template-interpolation' },
            { include: '#string-character-escape' }
        ]
    };

    const existingIndex = grammar.patterns.indexOf(existing);
    grammar.patterns.splice(existingIndex, 0, templatePattern);
}

grammar.repository['template-interpolation'] = interpolationPattern;
const output = `${JSON.stringify(grammar, null, 2)}\n`;
if (output !== original) {
    await writeFile(grammarPath, output);
}
