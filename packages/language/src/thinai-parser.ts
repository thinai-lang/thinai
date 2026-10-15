import { AstUtils, createLangiumParser, LangiumParserErrorMessageProvider, type LangiumCoreServices } from 'langium';
import { isSpecificationText, type SpecificationText } from './generated/ast.js';
import { getNewlineLengthAt, normalizeNewlines } from './thinai-text-utils.js';

const REFERENCE_MARKER_START = '\uE000thinai-reference-';
const REFERENCE_MARKER_END = '\uE001';

export class ThinaiParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
    override buildMismatchTokenMessage(
        options: Parameters<LangiumParserErrorMessageProvider['buildMismatchTokenMessage']>[0]
    ): string {
        const isEnumValuePosition = ['initial', 'from', 'to'].includes(options.previous.image.toLowerCase());
        const isQuotedValue = options.actual.image === '"' || options.actual.image === "'"
            || options.actual.image === '"""';
        if (options.expected.name === 'ID' && isEnumValuePosition && isQuotedValue) {
            return 'Enum values must be unquoted identifiers declared by the field\'s enum type.';
        }
        if (options.expected.name === 'ID' && options.ruleName.startsWith('EventReference') && isQuotedValue) {
            return 'Event names must be unquoted identifiers declared in the model.';
        }
        return super.buildMismatchTokenMessage(options);
    }
}

export function createThinaiParser(services: LangiumCoreServices) {
    const parser = createLangiumParser(services);
    const parse = parser.parse.bind(parser);
    parser.parse = ((input, options) => {
        const result = parse(input, options);
        for (const node of AstUtils.streamAst(result.value)) {
            if (isSpecificationText(node)) {
                dedentBehaviorText(node);
            }
        }
        return result;
    }) as typeof parser.parse;
    return parser;
}

function dedentBehaviorText(node: SpecificationText): void {
    const source = node.$cstNode?.text;
    if (!source || source.length < 2) {
        return;
    }

    const openingDelimiterLength = source.startsWith('"""') ? 3 : 1;
    const openingNewline = getNewlineLengthAt(source, openingDelimiterLength);
    if (openingNewline === 0 && !/[\r\n]/u.test(source)) {
        return;
    }

    const text = node.parts.map(part => part.text ?? '').join('');
    let markerStart = REFERENCE_MARKER_START;
    while (text.includes(markerStart)) {
        markerStart += '_';
    }
    const references = node.parts.filter(part => part.target);
    const markers = new Map(references.map((part, index) => [
        part,
        `${markerStart}${index}${REFERENCE_MARKER_END}`
    ]));
    let content = node.parts.map(part => part.text ?? markers.get(part) ?? '').join('');
    if (openingNewline > 0) {
        content = content.slice(openingNewline);
    }
    content = content.replace(/(?:\r\n|\r|\n)[ \t]*$/u, '');
    content = normalizeNewlines(content);

    const lines = content.split('\n');
    const indents = lines
        .filter(line => line.trim().length > 0)
        .map(line => line.match(/^[ \t]*/)?.[0] ?? '');
    const commonIndent = indents.reduce((common, indent) => {
        let length = 0;
        while (length < common.length && length < indent.length && common[length] === indent[length]) {
            length++;
        }
        return common.slice(0, length);
    }, indents[0] ?? '');

    content = lines.map(line => line.trim().length === 0 ? '' : line.slice(commonIndent.length)).join('\n');

    let offset = 0;
    for (const part of node.parts) {
        if (part.target) {
            const marker = markers.get(part)!;
            const markerOffset = content.indexOf(marker, offset);
            if (markerOffset >= 0) {
                offset = markerOffset + marker.length;
            }
        } else if (part.text !== undefined) {
            const nextMarker = [...markers.values()]
                .map(marker => content.indexOf(marker, offset))
                .filter(index => index >= 0)
                .sort((left, right) => left - right)[0];
            const end = nextMarker ?? content.length;
            part.text = content.slice(offset, end);
            offset = end;
        }
    }
}
