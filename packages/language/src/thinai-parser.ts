import { createLangiumParser, type AstNode, type LangiumCoreServices } from 'langium';
import { isSpecificationText, type SpecificationText } from './generated/ast.js';

const REFERENCE_MARKER_START = '\uE000thinai-reference-';
const REFERENCE_MARKER_END = '\uE001';

export function createThinaiParser(services: LangiumCoreServices) {
    const parser = createLangiumParser(services);
    const parse = parser.parse.bind(parser);
    parser.parse = ((input, options) => {
        const result = parse(input, options);
        for (const node of streamNodes(result.value)) {
            if (isSpecificationText(node)) {
                dedentBehaviorText(node);
            }
        }
        return result;
    }) as typeof parser.parse;
    return parser;
}

function* streamNodes(root: AstNode): Iterable<AstNode> {
    const pending: unknown[] = [root];
    while (pending.length > 0) {
        const value = pending.pop();
        if (Array.isArray(value)) {
            pending.push(...value);
            continue;
        }
        if (!value || typeof value !== 'object' || !('$type' in value)) {
            continue;
        }
        const node = value as AstNode;
        yield node;
        for (const [key, child] of Object.entries(node)) {
            if (!key.startsWith('$')) {
                pending.push(child);
            }
        }
    }
}

function dedentBehaviorText(node: SpecificationText): void {
    const source = node.$cstNode?.text;
    if (!source || source.length < 2) {
        return;
    }

    const openingNewline = source[1] === '\n' ? 1 : source.slice(1, 3) === '\r\n' ? 2 : 0;
    if (openingNewline === 0) {
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
    content = content.replace(/^\r?\n/, '');
    content = content.replace(/\r?\n[ \t]*$/, '');
    content = content.replace(/\r\n/g, '\n');

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
