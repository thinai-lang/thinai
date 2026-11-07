import { AstUtils, createLangiumParser, LangiumParserErrorMessageProvider, type LangiumCoreServices } from 'langium';
import { isSpecificationText, type SpecificationText } from './generated/ast.js';
import { getNewlineLengthAt, normalizeNewlines } from './thinai-text-utils.js';

const REFERENCE_MARKER_START = '\uE000thinai-reference-';
const REFERENCE_MARKER_END = '\uE001';

const declarationLabels: Record<string, string> = {
    Module: 'module',
    Aggregate: 'aggregate',
    Entity: 'entity',
    ValueObject: 'value object',
    EnumType: 'enum',
    DomainEvent: 'domain event',
    IntegrationEvent: 'integration event',
    ApplicationService: 'application service',
    DomainService: 'domain service',
    QueryService: 'query service',
    Repository: 'repository',
    QueryRepository: 'query repository',
    Factory: 'factory',
    Projector: 'projector',
    ReadModel: 'read model',
    DataObject: 'data object',
    Actor: 'actor',
    Journey: 'journey',
    Subdomain: 'subdomain',
    BoundedContext: 'bounded context',
    ContextMap: 'context map',
    SharedKernel: 'shared kernel',
    Field: 'field',
    Parameter: 'parameter',
    Method: 'method'
};

const clauseMessages: Record<string, string> = {
    ModuleReference: 'A `depends on` clause needs a module name.',
    NamedDeclarationReference: 'An `exposes` clause needs a declaration name.',
    JourneyActor: 'A `by` clause needs an actor name.',
    SubdomainReference: 'A `realizes` clause needs a subdomain name.',
    BoundedContextReference: 'A `participants` entry needs a bounded context name.',
    EventReference: 'An `emits` clause needs an event name.',
    ReadModelReference: 'A `projects` clause needs a read model name.',
    ReadSourceReference: 'A `reads from` clause needs a declaration name.',
    AggregateReference: 'A `reads from` clause needs an aggregate name.',
    MethodInvocation: 'An `invokes` clause needs a method name.'
};

function articleLabel(label: string): string {
    return `${/^[aeiou]/iu.test(label) ? 'An' : 'A'} ${label}`;
}

function normalizedRuleName(ruleName: string): string {
    return ruleName.replace(/[\u200B-\u200D\uFEFF]/gu, '');
}

function missingIdentifierMessage(
    ruleName: string,
    previousImage: string
): string | undefined {
    switch (ruleName) {
        case 'ImportComponent':
            return previousImage === 'as'
                ? 'An import alias needs a name.'
                : 'An import needs a component name.';
        case 'Field':
            return previousImage === 'initial'
                ? 'An `initial` value needs an enum value name.'
                : undefined;
        case 'Repository':
            if (previousImage === 'manages') {
                return 'A `manages` clause needs an entity name.';
            }
            if (previousImage === '.') {
                return 'A `manages` reference needs an entity name.';
            }
            return undefined;
        case 'QueryRepository':
            if (previousImage === 'serves') {
                return 'A `serves` clause needs a read model name.';
            }
            if (previousImage === '.') {
                return 'A `serves` reference needs a read model name.';
            }
            return undefined;
        case 'CollectionType':
            return 'A collection type reference needs a type name.';
        case 'ValueObject':
            return previousImage === '.'
                ? 'A `mirrors` reference needs a value object name.'
                : undefined;
        case 'BoundedContextPart':
            return 'An `in bounded context` clause needs a bounded context name.';
        case 'ContextMapEndpoint':
            return 'A context map relationship needs a bounded context name.';
        case 'SeparateWaysRelationship':
            return 'A `separateWays` relationship needs a bounded context name.';
        case 'SharedKernelRelationship':
            return 'A `sharedKernel` relationship needs a shared kernel name.';
        case 'SpecificationTextPart':
            return 'A specification reference needs a declaration name.';
        case 'EnumValue':
            return 'An enum value needs a name.';
        case 'TransitionChange':
            if (previousImage === 'from') {
                return 'A `transition` clause needs a `from` enum value name.';
            }
            if (previousImage === 'to') {
                return 'A `transition` clause needs a `to` enum value name.';
            }
            return 'A `transition` clause needs a field name.';
        default:
            return clauseMessages[ruleName];
    }
}

export class ThinaiParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
    override buildMismatchTokenMessage(
        options: Parameters<LangiumParserErrorMessageProvider['buildMismatchTokenMessage']>[0]
    ): string {
        const isEnumValuePosition = ['initial', 'from', 'to'].includes(options.previous.image.toLowerCase());
        const isQuotedValue = options.actual.image === '"' || options.actual.image === "'"
            || options.actual.image === '"""';
        const ruleName = normalizedRuleName(options.ruleName);
        if (options.expected.name === 'ID' && isEnumValuePosition && isQuotedValue) {
            return 'Enum values must be identifiers (use backticks for reserved names), not quoted strings.';
        }
        if (options.expected.name === 'ID' && ruleName.startsWith('EventReference') && isQuotedValue) {
            return 'Event names must be identifiers (use backticks for reserved names), not quoted strings.';
        }

        if ((ruleName === 'Entity' || ruleName === 'ValueObject') &&
            options.actual.image === ':' && options.expected.name !== 'ID') {
            return 'A field needs a name before `:`.';
        }

        if ((ruleName === 'Method' || ruleName === 'Constructor') &&
            options.actual.image === ':' && options.expected.name !== 'ID') {
            return 'A parameter needs a name before `:`.';
        }

        if (options.expected.name === 'ID') {
            const identifierMessage = missingIdentifierMessage(ruleName, options.previous.image);
            if (identifierMessage !== undefined) {
                return identifierMessage;
            }

            const declarationLabel = declarationLabels[ruleName];
            if (declarationLabel !== undefined) {
                const before = options.actual.image;
                if (before === ':' || before === '(' || before === '{') {
                    return `${articleLabel(declarationLabel)} needs a name before \`${before}\`.`;
                }
                return `${articleLabel(declarationLabel)} needs a name.`;
            }
        }

        return super.buildMismatchTokenMessage(options);
    }

    override buildNoViableAltMessage(
        options: Parameters<LangiumParserErrorMessageProvider['buildNoViableAltMessage']>[0]
    ): string {
        const ruleName = normalizedRuleName(options.ruleName);
        if (ruleName === 'JourneyStep') {
            return 'A journey step needs a command path after `invoke`.';
        }
        if (ruleName === 'Field') {
            return 'A field needs a type.';
        }
        if (ruleName === 'Parameter') {
            return 'A parameter needs a type.';
        }
        if (ruleName === 'CollectionType') {
            return 'A collection needs an element type.';
        }
        if (ruleName === 'Method' && options.previous.image === 'returns') {
            return 'A method needs a return type.';
        }
        return super.buildNoViableAltMessage(options);
    }

    override buildEarlyExitMessage(
        options: Parameters<LangiumParserErrorMessageProvider['buildEarlyExitMessage']>[0]
    ): string {
        if (normalizedRuleName(options.ruleName) === 'JourneyStep') {
            return 'A journey step needs a command path after `invoke`.';
        }
        return super.buildEarlyExitMessage(options);
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
