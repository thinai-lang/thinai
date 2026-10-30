import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import {
    createThinaiServices,
    isAggregate,
    isBoundedContextPart,
    isEntity,
    isField,
    isModel,
    isValueObject
} from 'thinai-language';
import { formatIdentifier, formatQualifiedName } from '../src/thinai-scope-utils.js';

let services: ReturnType<typeof createThinaiServices>;
let parse: ReturnType<typeof parseHelper<Model>>;
beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
    const doParse = parseHelper<Model>(services.Thinai);
    parse = (input: string) => doParse(input, { validation: true });
});

afterEach(async () => {
    await clearDocuments(services.shared, services.shared.workspace.LangiumDocuments.all.toArray());
});

function parseErrors(document: LangiumDocument): string[] {
    return [
        ...document.parseResult.lexerErrors.map(error => error.message),
        ...document.parseResult.parserErrors.map(error => error.message)
    ];
}

describe('Unicode identifiers', () => {
    test('parses and links identifiers in Latin, Tamil, and Han scripts', async () => {
        const document = await parse(`bounded context ஆர்டர்
in bounded context ஆர்டர் {
    aggregate ஆர்டர் {
        root entity ஆர்டர் {
            identifier id: ஆர்டர்Id
            name: string
        }
        value object ஆர்டர்Id {
            raw: string
        }
    }
}
bounded context 订单
in bounded context 订单 {
    aggregate 订单 {
        root entity 订单 {
            identifier id: 订单Id
            label: string
        }
        value object 订单Id {
            raw: string
        }
    }
}
bounded context Élève
in bounded context Élève {
    value object Straße {
        raw: string
    }
}`);
        expect(parseErrors(document)).toEqual([]);
        expect(isModel(document.parseResult.value)).toBe(true);

        const model = document.parseResult.value;
        const contexts = model.declarations.filter(isBoundedContextPart).map(part => part.context.ref?.name);
        expect(contexts).toEqual(['ஆர்டர்', '订单', 'Élève']);
    });

    test('links a Unicode field type to its Unicode value object', async () => {
        const document = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: ஆர்டர்Id
        }
        value object ஆர்டர்Id {
            raw: string
        }
    }
}`);
        expect(parseErrors(document)).toEqual([]);

        const model = document.parseResult.value;
        const part = model.declarations.filter(isBoundedContextPart)[0];
        const aggregate = part?.members.find(isAggregate);
        const entity = aggregate?.members.find(isEntity);
        const valueObject = aggregate?.members.find(isValueObject);
        const field = entity?.fields.find(isField);
        expect(field?.type?.ref).toBe(valueObject);
        expect(isValueObject(field?.type?.ref)).toBe(true);
    });

    test('accepts quoted identifiers with Unicode letters and spaces', async () => {
        const document = await parse('bounded context `ஆர்டர் சூழல்`\nin bounded context `ஆர்டர் சூழல்` {\n    value object `மதிப்பு பொருள்` {\n        raw: string\n    }\n}');
        expect(parseErrors(document)).toEqual([]);
        const model = document.parseResult.value;
        expect(model.declarations.filter(isBoundedContextPart)[0]?.context.ref?.name).toBe('ஆர்டர் சூழல்');
    });

    test('warns when an identifier is not in NFC form', async () => {
        const document = await parse('bounded context Cafe\u0301');
        const warning = document.diagnostics?.find(diagnostic => diagnostic.code === 'identifier-not-nfc');
        expect(warning).toBeDefined();
        expect(warning?.message).toContain("Use 'Café'");
    });

    test('does not warn for NFC identifiers', async () => {
        const document = await parse('bounded context Café');
        expect(document.diagnostics?.some(diagnostic => diagnostic.code === 'identifier-not-nfc')).toBe(false);
    });

    test('formats Unicode identifiers without backticks unless quoting is required', () => {
        expect(formatIdentifier('Élève')).toBe('Élève');
        expect(formatIdentifier('订单')).toBe('订单');
        expect(formatIdentifier('வாடிக்கையாளர்')).toBe('வாடிக்கையாளர்');
        expect(formatIdentifier('order line')).toBe('`order line`');
        expect(formatIdentifier('aggregate')).toBe('`aggregate`');
        expect(formatQualifiedName('订单.ஆர்டர்Id')).toBe('订单.ஆர்டர்Id');
    });
});
