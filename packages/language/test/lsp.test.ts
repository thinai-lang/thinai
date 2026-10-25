import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { AstUtils, EmptyFileSystem, isReference, type AstNode, type AstNodeDescription, type LangiumDocument, URI } from 'langium';
import { SemanticTokensDecoder } from 'langium/lsp';
import { clearDocuments } from 'langium/test';
import {
    applyConfiguredIndentation,
    applyConfiguredIndentationToCompletions,
    createThinaiServices,
    inferIndentationOptions,
    isQueryRepositoryReadCompletionPosition
} from '../src/index.js';
import { ThinaiNodeKindProvider } from '../src/thinai-node-kind-provider.js';
import { ThinaiCompletionProvider } from '../src/thinai-completion.js';
import { ThinaiCompletionDetails } from '../src/thinai-completion-details.js';
import { ThinaiImportCompletion } from '../src/thinai-import-completion.js';
import { createThinaiSelectionRange } from '../src/thinai-selection-range.js';
import { CompletionItemKind, InsertTextMode, SymbolKind, type CompletionItem, type CompletionList } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('LSP services', () => {
    test('provides quoted-string-first selection ranges across Thinai string constructs', () => {
        const source = `import "./external.tni"
context map Channels {
    customer Ordering { integrationPatterns: ["ACL"] } -> supplier Shipping
}
bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        invariant "aggregate invariant"
        root entity Order {
            constructor() {
                invariant "constructor invariant"
                precondition "constructor precondition"
                postcondition "constructor postcondition"
                behavior "constructor behavior"
            }
            method place() {
                invariant "method invariant"
                precondition "method precondition"
                postcondition "method postcondition"
                behavior "method behavior [[Order.place]]"
                invokes Order.place when "invoke guard"
                transition state from Draft to Placed when "transition guard"
                emits OrderPlaced when "emission guard"
            }
        }
    }
}
journey Checkout {
    by Customer {
        invoke Order.place with "journey arguments" when "journey guard"
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/selection-ranges.tni'), source
        );
        documents = [document];

        const cases = [
            ['"./external.tni"', 'import'],
            ['"ACL"', 'integrationPatterns'],
            ['"aggregate invariant"', 'invariant'],
            ['"constructor invariant"', 'invariant'],
            ['"constructor precondition"', 'precondition'],
            ['"constructor postcondition"', 'postcondition'],
            ['"constructor behavior"', 'behavior'],
            ['"method invariant"', 'invariant'],
            ['"method precondition"', 'precondition'],
            ['"method postcondition"', 'postcondition'],
            ['"method behavior [[Order.place]]"', 'behavior'],
            ['"invoke guard"', 'invokes'],
            ['"transition guard"', 'transition'],
            ['"emission guard"', 'emits'],
            ['"journey arguments"', 'with'],
            ['"journey guard"', 'when']
        ] as const;

        for (const [quotedText, enclosingKeyword] of cases) {
            const offset = source.indexOf(quotedText) + 1;
            const position = document.textDocument.positionAt(offset);
            const selection = createThinaiSelectionRange(document, position);

            expect(selection, quotedText).toBeDefined();
            expect(document.textDocument.getText(selection!.range), quotedText).toBe(quotedText);
            expect(selection!.parent, quotedText).toBeDefined();
            expect(document.textDocument.getText(selection!.parent!.range), quotedText).toContain(enclosingKeyword);
        }

        const statementCases = [
            ['"invoke guard"', 'invokes Order.place when "invoke guard"'],
            ['"transition guard"', 'transition state from Draft to Placed when "transition guard"'],
            ['"emission guard"', 'emits OrderPlaced when "emission guard"'],
            ['"journey arguments"', 'invoke Order.place with "journey arguments" when "journey guard"'],
            ['"journey guard"', 'invoke Order.place with "journey arguments" when "journey guard"']
        ] as const;
        for (const [quotedText, expectedStatement] of statementCases) {
            const position = document.textDocument.positionAt(source.indexOf(quotedText) + 1);
            const selection = createThinaiSelectionRange(document, position);
            expect(document.textDocument.getText(selection!.parent!.range), quotedText).toBe(expectedStatement);
        }
    });

    test('selects complete method statements before expanding to their method', () => {
        const source = `bounded context Ordering
context map Relations {
    customer Ordering -> supplier Shipping
    partner Ordering <-> partner Returns
    separateWays Ordering -x- Returns
    sharedKernel Common { participants: [Ordering, Shipping] }
}
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            method place() {
                invokes Order.place
                transition state from Draft to Placed
                emits OrderPlaced
                projects OrderSummary, OrderDetails
            }
        }
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/statement-selection-ranges.tni'), source
        );
        documents = [document];

        const cases = [
            ['invokes Order.place', 'invokes'],
            ['transition state from Draft to Placed', 'transition'],
            ['emits OrderPlaced', 'emits'],
            ['projects OrderSummary, OrderDetails', 'projects'],
            ['customer Ordering -> supplier Shipping', 'customer'],
            ['partner Ordering <-> partner Returns', 'partner'],
            ['separateWays Ordering -x- Returns', 'separateWays'],
            ['sharedKernel Common { participants: [Ordering, Shipping] }', 'sharedKernel']
        ] as const;

        for (const [statement, startToken] of cases) {
            const offset = source.indexOf(startToken) + 1;
            const selection = createThinaiSelectionRange(document, document.textDocument.positionAt(offset));

            expect(selection, statement).toBeDefined();
            expect(document.textDocument.getText(selection!.range), statement).toBe(statement);
            expect(selection!.parent, statement).toBeDefined();
            expect(document.textDocument.getText(selection!.parent!.range), statement).toContain(
                statement.startsWith('customer') || statement.startsWith('partner')
                    || statement.startsWith('separateWays') || statement.startsWith('sharedKernel')
                    ? 'context map'
                    : 'method place'
            );
        }
    });

    test('applies configured indentation to structurally indented completion edits', () => {
        const completionText = '\n  method\n  }';
        expect(applyConfiguredIndentation(completionText, 2, 2, true)).toBe('\n    method\n  }');
        expect(applyConfiguredIndentation(completionText, 2, 4, true)).toBe('\n        method\n  }');
        expect(applyConfiguredIndentation(completionText, 2, 4, false)).toBe('\n\t\tmethod\n  }');
        expect(applyConfiguredIndentation('\n  method\n  }', 2, 4, false, 1)).toBe('\n\t\tmethod\n\t}');
        expect(applyConfiguredIndentation('\r\n  method', 1, 2, true)).toBe('\r\n  method');
        const completionItems = [{
            label: 'method',
            data: { thinaiIndentationDepth: 2 },
            textEdit: {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '\n  method'
            }
        }];
        expect(applyConfiguredIndentationToCompletions(completionItems, 4, true)[0]?.textEdit?.newText)
            .toBe('\n        method');
        expect(applyConfiguredIndentationToCompletions(completionItems, 4, false)[0]?.textEdit?.newText)
            .toBe('\n\t\tmethod');
        const blockCompletionItems = [{
            label: 'method',
            data: { thinaiIndentationDepth: 2, thinaiClosingIndentationDepth: 1 },
            textEdit: {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '\n    method\n  '
            }
        }];
        expect(applyConfiguredIndentationToCompletions(blockCompletionItems, 4, false)[0]?.textEdit?.newText)
            .toBe('\n\t\tmethod\n\t');
        expect(inferIndentationOptions('root {\n    child {\n        leaf\n    }\n}'))
            .toEqual({ tabSize: 4, insertSpaces: true });
        expect(inferIndentationOptions('root {\n\tchild {\n\t\tleaf\n\t}\n}'))
            .toEqual({ tabSize: 4, insertSpaces: false });
        expect(inferIndentationOptions('root { child { leaf } }'))
            .toEqual({ tabSize: 2, insertSpaces: true });
        expect(inferIndentationOptions('root {\n    child {\n      aligned\n    }\n}'))
            .toEqual({ tabSize: 4, insertSpaces: true });
        const crlfCompletionItems = [{
            label: 'method',
            data: { thinaiIndentationDepth: 2, thinaiClosingIndentationDepth: 1 },
            textEdit: {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '\r\n  method\r\n  '
            }
        }];
        expect(applyConfiguredIndentationToCompletions(crlfCompletionItems, 4, true)[0]?.textEdit?.newText)
            .toBe('\r\n        method\r\n    ');
        expect(applyConfiguredIndentationToCompletions(crlfCompletionItems, 4, false)[0]?.textEdit?.newText)
            .toBe('\r\n\t\tmethod\r\n\t');
        expect(applyConfiguredIndentation(
            '\n    /* note */\n    method\n  ', 2, 4, false, 1, [2]
        )).toBe('\n\t\t/* note */\n\t\tmethod\n\t');
    });

    test('offers context members and declaration keywords automatically', async () => {
        const text = 'bounded context Sample in bounded context Sample {\n    \n}\n';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/declaration-completion.tni'), text
        );
        documents = [document];

        const position = text.indexOf('\n    ') + '    '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(position)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining([
            'aggregate', 'application service', 'domain service', 'repository', 'factory', 'projector',
            'query service', 'query repository', 'module', 'value object', 'read model', 'data object'
        ]));
        expect(labels).not.toContain('capability');
    });

    test('completes exposed references but not declaration names', async () => {
        const spaces = '   ';
        const text = `bounded context Ordering
        in bounded context Ordering {
            aggregate Order {
                root entity Root { identifier id: AggregateId }
                value object AggregateId { raw: string }
                value object${spaces}
            }
            value object OutsideId { raw: string }
            module Api {
                exposes${spaces}
                value object OrderId { raw: string }
            }
            module Sibling {
                value object SiblingId { raw: string }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/exposes-and-value-object-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const exposesOffset = text.indexOf('exposes') + 'exposes'.length + spaces.length;
        const exposesCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(exposesOffset)
        });
        expect(exposesCompletion?.items.find(item => item.label === 'OrderId')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringMatching(/^ValueObject .*Api\.OrderId$/)
        });
        for (const inaccessible of ['AggregateId', 'OutsideId', 'SiblingId']) {
            expect(exposesCompletion?.items.map(item => item.label)).not.toContain(inaccessible);
        }

        const sharedKernelText = `shared kernel CommonTypes {
            module SharedContracts {
                exposes${spaces}
                value object CorrelationId { raw: string }
            }
        }`;
        const sharedKernelDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-exposes-completion.tni'), sharedKernelText
        );
        documents.push(sharedKernelDocument);
        await services.shared.workspace.DocumentBuilder.build([sharedKernelDocument], { validation: false });
        const sharedExposesOffset = sharedKernelText.indexOf('exposes') + 'exposes'.length + spaces.length;
        const sharedExposesCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sharedKernelDocument, {
            textDocument: { uri: sharedKernelDocument.uri.toString() },
            position: sharedKernelDocument.textDocument.positionAt(sharedExposesOffset)
        });
        expect(sharedExposesCompletion?.items.find(item => item.label === 'CorrelationId')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringMatching(/^ValueObject .*SharedContracts\.CorrelationId$/)
        });

        const nestedCompletionCases = [
            { suffix: `${spaces}\n`, typed: '' },
            { suffix: ' E\n', typed: 'E' }
        ];
        for (const [index, completionCase] of nestedCompletionCases.entries()) {
            const nestedModuleText = `shared kernel CommonTypes {
                module SharedContracts {
                    value object CorrelationId { raw: string }
                    module Identifiers {
                        exposes${completionCase.suffix}
                        value object ExternalId { raw: string }
                    }
                }
            }`;
            const nestedModule = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/nested-module-exposes-completion-${index}.tni`), nestedModuleText
            );
            documents.push(nestedModule);
            await services.shared.workspace.DocumentBuilder.build([nestedModule], { validation: false });
            const referencePrefixStart = nestedModuleText.indexOf(`exposes${completionCase.suffix}`) + 'exposes'.length +
                (completionCase.typed ? 1 : spaces.length);
            const position = nestedModule.textDocument.positionAt(referencePrefixStart + completionCase.typed.length);
            const params = {
                textDocument: { uri: nestedModule.uri.toString() },
                position
            };
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nestedModule, params);
            const item = completion?.items.find(candidate => candidate.label === 'ExternalId');
            expect(item, completionCase.suffix).toMatchObject({
                kind: CompletionItemKind.Struct,
                detail: expect.stringMatching(/^ValueObject .*ExternalId$/)
            });
            if (completionCase.typed) {
                expect(item?.textEdit).toMatchObject({
                    range: {
                        start: nestedModule.textDocument.positionAt(referencePrefixStart),
                        end: position
                    },
                    newText: 'ExternalId'
                });
            }
        }

        const valueObjectOffset = text.indexOf('value object') + 'value object'.length + spaces.length;
        const valueObjectCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(valueObjectOffset)
        });
        expect(valueObjectCompletion?.items.some(item =>
            /^(?:ValueObject|Aggregate|Entity) /.test(item.detail ?? '')
        )).toBe(false);

        const declarationNameCases = [
            `bounded context Billing\nin bounded context Billing {\n    value object ExistingId { raw: string }\n    value object   \n}`,
            `bounded context Billing\nin bounded context Billing {\n    module Api {\n        value object ExistingId { raw: string }\n        value object   \n    }\n}`,
            `shared kernel CommonTypes {\n    value object ExistingId { raw: string }\n    value object   \n}`
        ];
        for (const [index, source] of declarationNameCases.entries()) {
            const declarationDocument = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/value-object-name-completion-${index}.tni`), source
            );
            documents.push(declarationDocument);
            await services.shared.workspace.DocumentBuilder.build([declarationDocument], { validation: false });
            const marker = source.indexOf('value object   ') + 'value object   '.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(declarationDocument, {
                textDocument: { uri: declarationDocument.uri.toString() },
                position: declarationDocument.textDocument.positionAt(marker)
            });
            expect(completion?.items.some(item =>
                /^(?:ValueObject|Aggregate|Entity|EnumType) /.test(item.detail ?? '')
            ), source).toBe(false);
        }
    });

    test('completes exposures in the nested modules from the fulfillment example', async () => {
        const text = await readFile(new URL('../../../examples/order-fulfillment/common-types.tni', import.meta.url), 'utf8');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types-exposure-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const cases = [
            { keywordOffset: text.indexOf('exposes CorrelationId') + 'exposes '.length, expected: ['CorrelationId', 'TenantId'] },
            { keywordOffset: text.indexOf('CorrelationId, TenantId') + 'CorrelationId, '.length, expected: ['TenantId'] },
            { keywordOffset: text.indexOf('exposes ExternalId') + 'exposes '.length, expected: ['ExternalId'] },
            { keywordOffset: text.indexOf('exposes ExternalId') + 'exposes E'.length, expected: ['ExternalId'] }
        ];
        for (const completionCase of cases) {
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.keywordOffset)
            });
            expect(completion?.items.map(item => item.label)).toEqual(expect.arrayContaining(completionCase.expected));
        }

        const marker = '__completion_position__';
        const afterExposureText = `shared kernel CommonTypes {
            module SharedContracts {
                module Identifiers {
                    exposes ExternalId
                    ${marker}
                    value object ExternalId { raw: string }
                }
            }
        }`;
        const afterExposure = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/nested-module-after-exposes-completion.tni'), afterExposureText
        );
        documents.push(afterExposure);
        await services.shared.workspace.DocumentBuilder.build([afterExposure], { validation: false });
        const afterExposurePosition = afterExposure.textDocument.positionAt(afterExposureText.indexOf(marker));
        const afterExposureCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(afterExposure, {
            textDocument: { uri: afterExposure.uri.toString() },
            position: afterExposurePosition
        });
        expect(afterExposureCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'value object', 'domain service', 'module'
        ]));
    });

    test('highlights linked behavior references as methods and fields', async () => {
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/behavior-highlighting.tni'),
            `bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                        status: string
                    }
                    value object OrderId { raw: string }
                }
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Place with [[Order.Order.place]] while status is [[Order.Order.status]]"
                    }
                }
            }`
        );
        documents = [source];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const provider = services.Thinai.lsp.SemanticTokenProvider;
        expect(provider).toBeDefined();
        const tokens = await provider!.semanticHighlight(source, {
            textDocument: { uri: source.uri.toString() }
        });
        const decoded = SemanticTokensDecoder.decode(tokens, provider!.tokenTypes, source);

        const highlightedReferences = decoded.filter(token => ['place', 'status'].includes(token.text));
        expect(highlightedReferences.map(token => [token.text, token.tokenType])).toEqual([
            ['place', 'method'],
            ['status', 'property'],
            ['place', 'method'],
            ['status', 'property']
        ]);
        expect(highlightedReferences.slice(0, 2).map(token => token.tokenModifiers)).toEqual([4, 4]);
    });

    test('classifies Thinai declarations with standard semantic token types', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/semantic-declarations.tni'),
            `bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                        status: OrderStatus
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
                event OrderPlaced
                domain service Authorization
            }`
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const provider = services.Thinai.lsp.SemanticTokenProvider;
        const tokens = await provider!.semanticHighlight(document, {
            textDocument: { uri: document.uri.toString() }
        });
        const decoded = SemanticTokensDecoder.decode(tokens, provider!.tokenTypes, document);
        const declarations = decoded.filter(token => token.tokenModifiers === 4);
        const declaredTypes = new Map(declarations.map(token => [token.text, token.tokenType]));
        expect(declaredTypes.get('Ordering')).toBe('namespace');
        expect(declaredTypes.get('Order')).toBe('class');
        expect(declaredTypes.get('OrderId')).toBe('struct');
        expect(declaredTypes.get('OrderStatus')).toBe('enum');
        expect(declaredTypes.get('Draft')).toBe('enumMember');
        expect(declaredTypes.get('Authorization')).toBe('class');
    });

    test('maps all Thinai symbols to standard completion and symbol kinds', () => {
        const provider = new ThinaiNodeKindProvider();
        const mappings: Array<[string, CompletionItemKind, SymbolKind]> = [
            ['Aggregate', CompletionItemKind.Class, SymbolKind.Class],
            ['Entity', CompletionItemKind.Class, SymbolKind.Class],
            ['ValueObject', CompletionItemKind.Struct, SymbolKind.Struct],
            ['DataObject', CompletionItemKind.Struct, SymbolKind.Struct],
            ['ReadModel', CompletionItemKind.Struct, SymbolKind.Struct],
            ['EnumType', CompletionItemKind.Enum, SymbolKind.Enum],
            ['EnumValue', CompletionItemKind.EnumMember, SymbolKind.EnumMember],
            ['Field', CompletionItemKind.Field, SymbolKind.Field],
            ['Parameter', CompletionItemKind.Variable, SymbolKind.Variable],
            ['Method', CompletionItemKind.Method, SymbolKind.Method],
            ['DomainEvent', CompletionItemKind.Event, SymbolKind.Event],
            ['IntegrationEvent', CompletionItemKind.Event, SymbolKind.Event],
            ['Repository', CompletionItemKind.Interface, SymbolKind.Interface],
            ['QueryRepository', CompletionItemKind.Interface, SymbolKind.Interface],
            ['Module', CompletionItemKind.Module, SymbolKind.Namespace],
            ['BoundedContext', CompletionItemKind.Module, SymbolKind.Namespace],
            ['BoundedContextPart', CompletionItemKind.Module, SymbolKind.Namespace],
            ['SharedKernel', CompletionItemKind.Module, SymbolKind.Namespace],
            ['Subdomain', CompletionItemKind.Module, SymbolKind.Namespace],
            ['ContextMap', CompletionItemKind.Module, SymbolKind.Namespace],
            ['Journey', CompletionItemKind.Function, SymbolKind.Function],
            ['Actor', CompletionItemKind.Variable, SymbolKind.Object],
            ['ApplicationService', CompletionItemKind.Class, SymbolKind.Class],
            ['DomainService', CompletionItemKind.Class, SymbolKind.Class],
            ['QueryService', CompletionItemKind.Class, SymbolKind.Class],
            ['Projector', CompletionItemKind.Class, SymbolKind.Class],
            ['Factory', CompletionItemKind.Class, SymbolKind.Class]
        ];

        for (const [type, completionKind, symbolKind] of mappings) {
            const node = { $type: type } as AstNode;
            expect(provider.getCompletionItemKind(node), `${type} completion kind`).toBe(completionKind);
            expect(provider.getSymbolKind(node), `${type} symbol kind`).toBe(symbolKind);
        }

        const unknownAst = { $type: 'Unknown' } as AstNode;
        const unknownDescription = { type: 'Unknown' } as AstNodeDescription;
        expect(provider.getCompletionItemKind(unknownAst)).toBe(CompletionItemKind.Reference);
        expect(provider.getCompletionItemKind(unknownDescription)).toBe(CompletionItemKind.Reference);
        expect(provider.getSymbolKind(unknownAst)).toBe(SymbolKind.Variable);
        expect(provider.getSymbolKind(unknownDescription)).toBe(SymbolKind.Variable);
    });

    test('describes completion details for methods, fields, parameters, and enum values', () => {
        const details = new ThinaiCompletionDetails(services.Thinai);
        const getDetail = (description: AstNodeDescription) => details.getCompletionDetail(description);
        const typeNode = (type: string, name: string) => ({ $type: type, name }) as AstNode;
        const domainEvent = typeNode('DomainEvent', 'OrderPlaced');

        expect(getDetail({ type: 'Method', name: 'external' } as AstNodeDescription)).toBe('Method external');
        expect(getDetail({
            type: 'Method',
            name: 'find',
            node: {
                $type: 'Method',
                name: 'find',
                parameters: [
                    { $type: 'Parameter', name: 'id', primitive: 'string', optional: false },
                    { $type: 'Parameter', name: 'source', type: { ref: domainEvent, $refText: 'OrderPlaced' }, optional: true },
                    { $type: 'Parameter', name: 'ids', collection: { kind: 'List', elementPrimitive: 'number' }, optional: false }
                ],
                returnType: { ref: typeNode('ValueObject', 'OrderId'), $refText: 'OrderId' }
            } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method find(id: string, source?: event OrderPlaced, ids: List<number>) returns OrderId');
        expect(getDetail({
            type: 'Method',
            name: 'summarize',
            node: {
                $type: 'Method', name: 'summarize', parameters: [],
                returnCollection: {
                    kind: 'Map',
                    elementCollection: { kind: 'Set', elementType: { ref: typeNode('ValueObject', 'OrderId'), $refText: 'OrderId' } },
                    valueCollection: { kind: 'List', elementPrimitive: 'string' }
                }
            } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method summarize() returns Map<Set<OrderId>, List<string>>');
        expect(getDetail({
            type: 'Method',
            name: 'count',
            node: { $type: 'Method', name: 'count', parameters: [], returnPrimitive: 'number' } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method count() returns number');
        expect(getDetail({
            type: 'Method',
            name: 'clear',
            node: { $type: 'Method', name: 'clear', parameters: [] } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method clear()');

        expect(getDetail({
            type: 'Field',
            name: 'items',
            node: { $type: 'Field', name: 'items', collection: { kind: 'List', elementPrimitive: 'number' } } as unknown as AstNode
        } as AstNodeDescription)).toBe('Field items: List<number>');
        expect(getDetail({
            type: 'Field',
            name: 'status',
            node: { $type: 'Field', name: 'status', type: { ref: typeNode('EnumType', 'OrderStatus'), $refText: 'OrderStatus' } } as unknown as AstNode
        } as AstNodeDescription)).toBe('Field status: OrderStatus');
        expect(getDetail({
            type: 'Parameter',
            name: 'source',
            node: { $type: 'Parameter', name: 'source', type: { ref: domainEvent, $refText: 'OrderPlaced' }, optional: false } as unknown as AstNode
        } as AstNodeDescription)).toBe('Parameter source: event OrderPlaced');
        expect(getDetail({
            type: 'Parameter',
            name: 'source',
            node: { $type: 'Parameter', name: 'source', type: { ref: domainEvent, $refText: 'OrderPlaced' }, optional: true } as unknown as AstNode
        } as AstNodeDescription)).toBe('Parameter source?: event OrderPlaced');
        expect(getDetail({
            type: 'Parameter',
            name: 'value',
            node: { $type: 'Parameter', name: 'value', optional: false } as unknown as AstNode
        } as AstNodeDescription)).toBe('Parameter value: unknown');
        expect(getDetail({
            type: 'EnumValue',
            name: 'Placed',
            node: { $type: 'EnumValue', name: 'Placed', $container: typeNode('EnumType', 'OrderStatus') } as unknown as AstNode
        } as AstNodeDescription)).toBe('Enum value OrderStatus.Placed (OrderStatus)');
        expect(getDetail({
            type: 'Aggregate',
            name: 'Order',
            node: { $type: 'Aggregate', name: 'Order' } as AstNode
        } as AstNodeDescription)).toBe('Aggregate Order');
    });

    test('resolves imported completion details without an attached AST node', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/imported-detail.tni'),
            `bounded context Ordering
in bounded context Ordering {
    value object Money {
        amount: number
    }
}`
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const field = AstUtils.streamAst(document.parseResult.value)
            .find(node => node.$type === 'Field' && 'name' in node && node.name === 'amount');
        expect(field).toBeDefined();
        const description = {
            type: 'Field',
            name: 'Ordering.Money.amount',
            documentUri: document.uri,
            path: services.Thinai.workspace.AstNodeLocator.getAstNodePath(field!)
        } as AstNodeDescription;
        const details = new ThinaiCompletionDetails(services.Thinai);
        expect(details.getCompletionDetail(description)).toBe('Field Ordering.Money.amount: number');
    });

    test('suggests workspace files inside import paths', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file("/workspace/order's.tni"),
            'bounded context Ordering'
        );
        documents = [target];
        const sourceText = 'import "./order\'s';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-consumer.tni'),
            sourceText
        );
        documents.push(source);

        const workspaceManager = services.shared.workspace.WorkspaceManager;
        const workspaceFolders = vi.spyOn(workspaceManager, 'workspaceFolders', 'get').mockReturnValue([
            { uri: URI.file('/workspace').toString(), name: 'workspace' }
        ]);
        const searchFolder = vi.spyOn(workspaceManager, 'searchFolder').mockResolvedValue([
            URI.file('/workspace/notes.md')
        ]);

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(sourceText.length)
        });
        await services.Thinai.lsp.CompletionProvider?.getCompletion(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(sourceText.length)
        });
        expect(searchFolder).toHaveBeenCalledTimes(1);

        const importSuggestions = completion?.items.filter(item => item.kind === CompletionItemKind.File) ?? [];
        expect(importSuggestions.map(item => item.label)).toEqual(["./order's.tni"]);
        expect(importSuggestions[0].textEdit).toMatchObject({
            newText: "./order's.tni",
            range: {
                start: source.textDocument.positionAt('import "'.length),
                end: source.textDocument.positionAt(sourceText.length)
            }
        });

        const tripleQuotedText = 'import """./order';
        const tripleQuoted = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/triple-quoted-import.tni'), tripleQuotedText
        );
        documents.push(tripleQuoted);
        const tripleCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(tripleQuoted, {
            textDocument: { uri: tripleQuoted.uri.toString() },
            position: tripleQuoted.textDocument.positionAt(tripleQuotedText.length)
        });
        expect(tripleCompletion?.items.find(item => item.label === "./order's.tni")?.textEdit).toMatchObject({
            newText: "./order's.tni",
            range: {
                start: tripleQuoted.textDocument.positionAt('import """'.length),
                end: tripleQuoted.textDocument.positionAt(tripleQuotedText.length)
            }
        });

        const multilineTripleText = 'import """\r\n    ./order';
        const multilineTriple = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiline-triple-quoted-import.tni'), multilineTripleText
        );
        documents.push(multilineTriple);
        const multilineTripleCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(multilineTriple, {
            textDocument: { uri: multilineTriple.uri.toString() },
            position: multilineTriple.textDocument.positionAt(multilineTripleText.length)
        });
        expect(multilineTripleCompletion?.items.find(item => item.label === "./order's.tni")?.textEdit).toMatchObject({
            newText: "./order's.tni",
            range: {
                start: multilineTriple.textDocument.positionAt('import """'.length),
                end: multilineTriple.textDocument.positionAt(multilineTripleText.length)
            }
        });

        const separatedImportText = 'import\r\n"""\r\n    ./order';
        const separatedImport = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/separated-triple-quoted-import.tni'), separatedImportText
        );
        documents.push(separatedImport);
        const separatedImportCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(separatedImport, {
            textDocument: { uri: separatedImport.uri.toString() },
            position: separatedImport.textDocument.positionAt(separatedImportText.length)
        });
        expect(separatedImportCompletion?.items.find(item => item.label === "./order's.tni")?.textEdit).toMatchObject({
            newText: "./order's.tni",
            range: {
                start: separatedImport.textDocument.positionAt('import\r\n"""'.length),
                end: separatedImport.textDocument.positionAt(separatedImportText.length)
            }
        });

        workspaceFolders.mockRestore();
        searchFolder.mockRestore();

        const outsideImport = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/outside-import.tni'), 'actor Customer'
        );
        documents.push(outsideImport);
        const ordinaryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(outsideImport, {
            textDocument: { uri: outsideImport.uri.toString() },
            position: outsideImport.textDocument.positionAt('actor Customer'.length)
        });
        expect(ordinaryCompletion?.items.some(item => item.kind === CompletionItemKind.File)).toBe(false);
    });

    test('caches import file searches and invalidates them on file create and delete', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-cache.tni'), 'import "./'
        );
        documents = [document];
        const workspaceManager = services.shared.workspace.WorkspaceManager;
        const workspaceFolders = vi.spyOn(workspaceManager, 'workspaceFolders', 'get').mockReturnValue([
            { uri: URI.file('/workspace').toString(), name: 'workspace' }
        ]);
        const searchFolder = vi.spyOn(workspaceManager, 'searchFolder').mockResolvedValue([]);
        const updateListeners: Array<(changed: URI[], deleted: URI[]) => void> = [];
        const onUpdate = vi.spyOn(services.shared.workspace.DocumentBuilder, 'onUpdate').mockImplementation(callback => {
            updateListeners.push(callback);
            return { dispose: () => undefined };
        });
        const completion = new ThinaiImportCompletion(services.Thinai);

        const getCompletions = () => completion.getCompletions(document, './', 9);
        await getCompletions();
        await getCompletions();
        expect(searchFolder).toHaveBeenCalledTimes(1);

        const addedUri = URI.file('/workspace/new-file.tni');
        updateListeners[0]!([addedUri], []);
        await getCompletions();
        expect(searchFolder).toHaveBeenCalledTimes(2);

        updateListeners[0]!([], [addedUri]);
        await getCompletions();
        expect(searchFolder).toHaveBeenCalledTimes(3);

        onUpdate.mockRestore();
        searchFolder.mockRestore();
        workspaceFolders.mockRestore();
    });

    test('navigates from import paths to the start of target documents', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types.tni'),
            'shared kernel CommonTypes {}'
        );
        const importText = 'import "./common-types.tni"';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-link.tni'), importText
        );
        documents = [target, source];

        const pathOffset = importText.indexOf('./common-types.tni');
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(pathOffset)
        });
        expect(definitions).toHaveLength(1);
        expect(definitions?.[0]?.targetUri).toBe(target.uri.toString());
        expect(definitions?.[0]?.originSelectionRange).toEqual({
            start: source.textDocument.positionAt(pathOffset),
            end: source.textDocument.positionAt(pathOffset + './common-types.tni'.length)
        });
        expect(definitions?.[0]?.targetSelectionRange.start).toEqual({ line: 0, character: 0 });
    });

    test('navigates from an initial state to its enum value declaration', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    identifier id: OrderId
                    status: OrderStatus initial Draft
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/initial-state-definition.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const initialValueOffset = text.indexOf('Draft', text.indexOf('initial'));
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(initialValueOffset)
        });

        expect(definitions).toHaveLength(1);
        expect(definitions?.[0]?.targetUri).toBe(document.uri.toString());
        expect(definitions?.[0]?.targetSelectionRange.start).toEqual(
            document.textDocument.positionAt(text.lastIndexOf('Draft'))
        );
    });

    test('navigates only from within quoted import paths, including triple-quoted paths', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types.tni'), 'shared kernel CommonTypes {}'
        );
        const sourceText = `import './common-types.tni'\nimport { CommonTypes } from "./common-types.tni"\nimport """./common-types.tni"""`;
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/quoted-imports.tni'), sourceText
        );
        documents = [target, source];
        const provider = services.Thinai.lsp.DefinitionProvider!;

        const pathStarts = [
            sourceText.indexOf('./common-types.tni'),
            sourceText.indexOf('./common-types.tni', sourceText.indexOf('from')),
            sourceText.lastIndexOf('./common-types.tni')
        ];
        for (const pathStart of pathStarts) {
            const definition = await provider.getDefinition(source, {
                textDocument: { uri: source.uri.toString() },
                position: source.textDocument.positionAt(pathStart)
            });
            expect(definition).toHaveLength(1);
            expect(definition?.[0]?.targetUri).toBe(target.uri.toString());
            expect(definition?.[0]?.originSelectionRange?.start)
                .toEqual(source.textDocument.positionAt(pathStart));
            expect(definition?.[0]?.originSelectionRange?.end)
                .toEqual(source.textDocument.positionAt(pathStart + './common-types.tni'.length));
        }

        const closingQuote = sourceText.indexOf("'./common-types.tni'") + './common-types.tni'.length + 1;
        expect(await provider.getDefinition(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(closingQuote)
        })).toBeUndefined();
    });

    test('completes invocation path segments with Thinai symbol kinds', async () => {
        const template = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place()
                    method submit() { invokes   }
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
            }
        }`;
        documents = [];
        for (const prefix of ['', 'O', 'Or', 'Order']) {
            const typedText = template.replace('invokes  ', `invokes ${prefix} `);
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/invocation-completion-${prefix || 'empty'}.tni`), typedText
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const source = typedText.indexOf(`invokes ${prefix} `) + 'invokes '.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'Order' && item.detail?.includes('Aggregate') === true)).toBe(true);
        }

        const withPrefix = template.replace('invokes  ', 'invokes Order. ');
        const prefixedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invocation-completion-prefix.tni'), withPrefix
        );
        documents.push(prefixedDocument);
        await services.shared.workspace.DocumentBuilder.build([prefixedDocument], { validation: true });
        const childSegmentOffset = withPrefix.indexOf('invokes Order.') + 'invokes Order.'.length;
        const childItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(prefixedDocument, {
            textDocument: { uri: prefixedDocument.uri.toString() },
            position: prefixedDocument.textDocument.positionAt(childSegmentOffset)
        });
        expect(childItems?.items.find(item => item.label === 'place')).toMatchObject({
            kind: CompletionItemKind.Method,
            detail: expect.stringContaining('place(')
        });
        expect(childItems?.items.find(item => item.label === 'Order')).toMatchObject({
            kind: CompletionItemKind.Class,
            detail: expect.stringContaining('Entity Order')
        });
    });

    test('keeps nested behavior references available while typing', async () => {
        for (const prefix of ['o', 'or', 'order']) {
            const text = `bounded context Ordering in bounded context Ordering {
                data object Request { orderId: string }
                application service OrderApplication {
                    method place(request: Request) { behavior "
                        Use [[request.${prefix}]]
                    " }
                }
            }`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/specification-completion-${prefix}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

            const referenceStart = text.indexOf('[[request.') + '[[request.'.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(referenceStart + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'orderId' && item.kind === CompletionItemKind.Field)).toBe(true);
        }
    });

    test('completes and links a nested shape reused by multiple input fields', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            data object Address { street: string }
            data object Request {
                billing: Address
                shipping: Address
            }
            application service OrderApplication {
                method submit(input: Request) {
                    behavior "Use [[input.shipping.street]] and [[input.shipping.st]]"
                }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reused-nested-shape-specification.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const linkedPart = AstUtils.streamAst(document.parseResult.value)
            .filter(node => node.$type === 'SpecificationTextPart' && node.$cstNode?.text.includes('input.shipping.street'))
            .toArray()[0];
        expect(linkedPart).toBeDefined();
        const linkedReferences = linkedPart
            ? AstUtils.streamReferences(linkedPart).map(info => info.reference).filter(isReference).toArray()
            : [];
        expect(linkedReferences.map(reference => reference.ref && 'name' in reference.ref
            ? reference.ref.name
            : undefined)).toEqual(['input', 'shipping', 'street']);
        expect(linkedReferences.map(reference => reference.error)).toEqual([undefined, undefined, undefined]);

        const typedPrefix = 'input.shipping.st';
        const offset = text.indexOf(typedPrefix, text.indexOf('and [[')) + typedPrefix.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.find(item => item.label === 'street' && item.kind === CompletionItemKind.Field)).toBeDefined();
    });

    test('completes specification fields through collection elements and map values', async () => {
        const text = `bounded context Ordering
        in bounded context Ordering {
            data object Line {
                sku: string
            }
            data object Request {
                lines: List<Line>
                byId: Map<string, Line>
                nested: List<Map<string, Line>>
            }
            data object Response {
                lines: List<Line>
            }
            application service OrderApplication {
                method submit(input: Request, items: List<Line>, nested: List<Map<string, Line>>) {
                    behavior "Use [[input.lines.sku]], [[input.byId.sku]], [[input.nested.sku]], [[items.sku]], and [[nested.sku]]."
                }
            }
            query service OrderQueries {
                method search() returns Map<string, Response> {
                    behavior "Use [[result.lines.sku]]."
                }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/collection-shape-specification.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const references = [
            'input.lines.sk',
            'input.byId.sk',
            'input.nested.sk',
            'items.sk',
            'nested.sk',
            'result.lines.sk'
        ];
        for (const prefix of references) {
            const referenceStart = text.indexOf(`[[${prefix}`);
            const offset = referenceStart + 2 + prefix.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.find(item => item.label === 'sku' && item.kind === CompletionItemKind.Field), prefix)
                .toBeDefined();
        }

        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('resolves and completes journey query results through an aliased context import', async () => {
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/aliased-query-catalog.tni'),
            `bounded context Catalog in bounded context Catalog {
                module PublicApi {
                    exposes ProductQueries, ProductInfo
                    query service ProductQueries {
                        method findProduct() returns ProductInfo
                    }
                    data object ProductInfo { available: boolean }
                }
            }`
        );
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/aliased-query-ordering.tni'),
            `bounded context Ordering in bounded context Ordering {
                application service Commands { method placeOrder() }
            }`
        );
        const source = `import { Catalog as Products } from "./aliased-query-catalog.tni"
            import "./aliased-query-ordering.tni"
            actor Customer
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.Commands.placeOrder when "Product is [[Products.PublicApi.ProductQueries.findProduct.result.available]]."
                }
            }`;
        const journey = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/aliased-query-journey.tni'), source
        );
        documents.push(catalog, ordering, journey);
        await services.shared.workspace.DocumentBuilder.build([catalog, ordering, journey], { validation: true });

        const referencePart = AstUtils.streamAst(journey.parseResult.value)
            .find(node => node.$type === 'SpecificationTextPart' && 'target' in node && node.target);
        expect(referencePart).toBeDefined();
        const references = referencePart
            ? AstUtils.streamReferences(referencePart).map(info => info.reference).filter(isReference).toArray()
            : [];
        expect(references.at(-1)?.ref?.$type).toBe('Field');
        expect(references.map(reference => reference.error)).toEqual(references.map(() => undefined));

        const typedPath = 'Products.PublicApi.ProductQueries.findProduct.result.av';
        const offset = source.indexOf(typedPath) + typedPath.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(journey, {
            textDocument: { uri: journey.uri.toString() },
            position: journey.textDocument.positionAt(offset)
        });
        expect(completion?.items.find(item => item.label === 'available' && item.kind === CompletionItemKind.Field))
            .toBeDefined();
    });

    test('does not offer language keywords in multiline specification prose', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'closed double-quoted multiline specification',
                source: `bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior "
                            Place the order; literal \\[[ is not a reference.
                            inv${marker}
                        " }
                    }
                }`
            },
            {
                name: 'closed triple-double-quoted multiline specification',
                source: `bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior """
                            Literal { braces } and [[ links stay prose.
                            inv${marker}
                        """ }
                    }
                }`
            },
            {
                name: 'open single-quoted multiline specification with an escaped quote',
                source: String.raw`bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior '
                            The order\'s status is still being described.
                            tran${marker}`
            },
            {
                name: 'open double-quoted specification ending in an escaped quote',
                source: String.raw`bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior "Still prose with an escaped quote \"${marker}`
            },
            {
                name: 'open triple-double-quoted specification ending in one quote',
                source: `bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior """
                            Still prose with an incomplete delimiter "${marker}`
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const text = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/multiline-specification-keyword-completion-${index}.tni`), text
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items ?? [], completionCase.name).toEqual([]);
        }
    });

    test('triggers completion when an inline specification reference opens', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            data object Request { orderId: string }
            application service OrderApplication {
                method place(request: Request) { behavior "Use [[request.orderId]]" }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-open-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toContain('[');
        const openingOffset = text.indexOf('[[request.orderId]]') + '[['.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(openingOffset)
        });
        expect(completion?.items.some(item => item.label === 'request' && item.kind === CompletionItemKind.Variable)).toBe(true);
    });

    test('completes the first symbol in an unfinished inline specification reference', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            data object Request { orderId: string }
            application service OrderApplication {
                method place(request: Request) { behavior "Use [[`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-incomplete-reference-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const position = document.textDocument.positionAt(text.length);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position
        });
        const parameter = completion?.items.find(item => item.label === 'request');

        expect(parameter).toMatchObject({
            kind: CompletionItemKind.Variable,
            textEdit: {
                range: { start: position, end: position },
                newText: 'request'
            }
        });
        expect(completion?.items.some(item => item.kind === CompletionItemKind.Keyword)).toBe(false);
    });

    test('resolves aggregate-qualified specification fields across imported files with repeated names', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            `bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method fulfillItem() {
                            behavior "Check the local [[sta]]"
                        }
                        identifier id: OrderId
                        customerId: string
                        status: string
                    }
                    value object OrderId { raw: string }
                }
            }`
        );
        const consumerText = `import "./ordering.tni"
            in bounded context Ordering {
                application service OrderItemFulfillment {
                    method fulfillItem(orderId: OrderId, itemId: OrderItemId) {
                        invokes Order.Order.fulfillItem
                        behavior "Ship the selected [[Order.Order.customerId]] child item through the aggregate root."
                        postcondition "The referenced field is never guessed as [[customerId]]."
                    }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-events.tni'), consumerText
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const model = consumer.parseResult.value;
        const referencePart = model && AstUtils.streamAst(model)
            .find(node => node.$type === 'SpecificationTextPart' && 'target' in node && node.target);
        expect(referencePart).toBeDefined();
        if (!referencePart || !('target' in referencePart)) {
            return;
        }
        const references = AstUtils.streamReferences(referencePart)
            .map(info => info.reference)
            .filter(isReference)
            .toArray();
        expect(references.map(reference => reference.ref?.$type)).toEqual(['Aggregate', 'Entity', 'Field']);
        expect(references.map(reference => reference.error)).toEqual([undefined, undefined, undefined]);

        const localPrefixEnd = producer.textDocument.getText().indexOf('[[sta]]') + '[[sta'.length;
        const localCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(producer, {
            textDocument: { uri: producer.uri.toString() },
            position: producer.textDocument.positionAt(localPrefixEnd)
        });
        expect(localCompletion?.items.find(item => item.label === 'status')).toMatchObject({
            kind: CompletionItemKind.Field
        });

        const firstSegmentEnd = consumerText.indexOf('[[Order.Order.customerId]]') + '[[Order'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(firstSegmentEnd)
        });
        expect(completion?.items.find(item => item.label === 'Order' && item.detail?.includes('Aggregate'))).toMatchObject({
            kind: CompletionItemKind.Class
        });
        expect(consumer.diagnostics?.some(diagnostic =>
            diagnostic.message === "Could not resolve reference to SpecificationTarget named 'Order'."
        )).toBe(false);
        expect(consumer.diagnostics?.some(diagnostic =>
            diagnostic.message === "Could not resolve reference to SpecificationTarget named 'customerId'."
        )).toBe(true);
        const bareFieldOpening = consumerText.indexOf('[[customerId]]') + '[['.length;
        const bareFieldCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(bareFieldOpening)
        });
        expect(bareFieldCompletion?.items.some(item => item.label === 'customerId')).toBe(false);
    });

    test('filters reads-from completion candidates by CQRS method role', async () => {
        const marker = '__read_source__';
        const source = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            read model OrderSummary { status: string }
            query repository OrderSummaryRepository {
                serves OrderSummary
            }
            application service Commands {
                method place() { reads from ${marker} }
            }
            query service Queries {
                method find() returns OrderSummary { reads from ${marker} }
            }
        }`;
        const positions = [...source.matchAll(new RegExp(marker, 'g'))].map(match => match.index!);
        const text = source.replace(marker, '').replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const appPosition = document.textDocument.positionAt(positions[0]!);
        const queryPosition = document.textDocument.positionAt(positions[1]! - marker.length);
        const appCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: appPosition
        });
        const queryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: queryPosition
        });
        const appLabels = appCompletion?.items.map(item => item.label) ?? [];
        const queryLabels = queryCompletion?.items.map(item => item.label) ?? [];
        expect(appLabels).toContain('OrderRepository');
        expect(appLabels).not.toContain('OrderSummaryRepository');
        expect(queryLabels).toContain('OrderSummaryRepository');
        expect(queryLabels).not.toContain('OrderRepository');
        const repositoryItem = appCompletion?.items.find(item => item.label === 'OrderRepository');
        expect(repositoryItem?.kind).toBe(CompletionItemKind.Interface);
        expect(repositoryItem?.textEdit).toMatchObject({
            newText: 'OrderRepository',
            range: { start: appPosition, end: appPosition }
        });
    });

    test('does not offer method-body siblings while completing a reads-from source', async () => {
        const prefix = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            application service Commands {
                method place() {
                    reads from OrderRep`;
        const source = `${prefix}\n                }\n            }\n        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-partial-source.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('OrderRepository');
        for (const sibling of ['behavior', 'invokes', 'reads from', 'projects', 'invariant', 'postcondition']) {
            expect(labels).not.toContain(sibling);
        }
    });

    test('offers method-body siblings after a complete reads-from source', async () => {
        const prefix = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            application service Commands {
                method place() {
                    reads from OrderRepository`;
        const source = `${prefix}\n                }\n            }\n        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-complete-source-sibling.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const behavior = completion?.items.find(item => item.label === 'behavior');
        expect(behavior).toBeDefined();
        expect(behavior?.data?.thinaiSiblingCompletion).toBe(true);
    });

    test('completes authorized external query methods as reads-from sources', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-contexts.tni'),
            'bounded context Catalog bounded context Ordering'
        );
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-catalog.tni'),
            `import "./read-api-contexts.tni"
             in bounded context Catalog {
                 module PublicApi {
                     exposes ProductQueries, ProductInfo
                     query service ProductQueries {
                         method findProduct(sku: string) returns ProductInfo
                     }
                     data object ProductInfo {
                         available: boolean
                     }
                 }
             }`
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-map.tni'),
            `import "./read-api-contexts.tni"
             context map Commerce {
                 customer Ordering -> supplier Catalog
             }`
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-consumer.tni'),
            `import "./read-api-contexts.tni"
             import "./read-api-catalog.tni"
             import { Commerce } from "./read-api-map.tni"
             in bounded context Ordering {
                 application service OrderCommands {
                     method checkProduct(sku: string) {
                         reads from Catalog.PublicApi.ProductQueries.
                     }
                 }
             }`
        );
        documents.push(contexts, catalog, contextMap, consumer);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(consumer.textDocument.getText().indexOf('ProductQueries.') + 'ProductQueries.'.length)
        });
        const queryItem = completion?.items.find(item => item.label === 'findProduct');
        expect(queryItem).toBeDefined();
        expect(queryItem?.kind).toBe(CompletionItemKind.Method);
        const cursorOffset = consumer.textDocument.getText().indexOf('ProductQueries.') + 'ProductQueries.'.length;
        expect(queryItem?.textEdit).toMatchObject({
            newText: 'findProduct',
            range: {
                start: consumer.textDocument.positionAt(cursorOffset),
                end: consumer.textDocument.positionAt(cursorOffset)
            }
        });
        expect(completion?.items.map(item => item.label)).not.toContain('OrderRepository');
    });

    test('completes structural read-source roots and appends continuation dots', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-root-contexts.tni'),
            'bounded context Catalog bounded context Ordering'
        );
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-root-catalog.tni'),
            `import "./read-root-contexts.tni"
             in bounded context Catalog {
                 module PublicApi {
                     exposes ProductQueries, ProductInfo
                     data object ProductInfo { available: boolean }
                     query service ProductQueries {
                         method findProduct(sku: string) returns ProductInfo
                     }
                 }
             }`
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-root-map.tni'),
            `import "./read-root-contexts.tni"
             context map Commerce {
                 customer Ordering -> supplier Catalog
             }`
        );
        const consumerText = `import "./read-root-contexts.tni"
import "./read-root-catalog.tni"
import { Commerce } from "./read-root-map.tni"
in bounded context Ordering {
    application service App {
        method check() {
            reads from __CURSOR__
        }
    }
}`;
        const emptyConsumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-root-consumer-empty.tni'), consumerText.replace('__CURSOR__', '')
        );
        const partialConsumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-root-consumer-partial.tni'), consumerText.replace('__CURSOR__', 'Cat')
        );
        documents.push(contexts, catalog, contextMap, emptyConsumer, partialConsumer);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const completeAt = async (document: LangiumDocument, offset: number) =>
            services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });

        const emptyOffice = consumerText.indexOf('__CURSOR__');
        const emptyItems = await completeAt(emptyConsumer, emptyOffice);
        expect(emptyItems?.items.map(item => item.label)).toContain('Catalog');
        expect(emptyItems?.items.find(item => item.label === 'Catalog')?.textEdit?.newText).toBe('Catalog.');

        const partialOffset = consumerText.indexOf('__CURSOR__') + 'Cat'.length;
        const partialItems = await completeAt(partialConsumer, partialOffset);
        expect(partialItems?.items.map(item => item.label)).toContain('Catalog');
        expect(partialItems?.items.find(item => item.label === 'Catalog')?.textEdit?.newText).toBe('Catalog.');

        const sameContextText = `bounded context C
in bounded context C {
    aggregate A {
        root entity A {
            identifier id: Id
        }
        value object Id { raw: string }
    }
    module M {
        exposes R
        repository R {
            manages A.A
        }
    }
    application service App {
        method check() {
            reads from __CURSOR__
        }
    }
}`;
        const sameOffset = sameContextText.indexOf('__CURSOR__');
        const sameContext = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-root-same-context.tni'),
            sameContextText.replace('__CURSOR__', '')
        );
        documents.push(sameContext);
        await services.shared.workspace.DocumentBuilder.build([sameContext], { validation: false });
        const sameItems = await completeAt(sameContext, sameOffset);
        expect(sameItems?.items.map(item => item.label)).toContain('M');
        expect(sameItems?.items.find(item => item.label === 'M')?.textEdit?.newText).toBe('M.');
    });

    test('filters read-source structural roots with no accessible repository descendant', async () => {
        const source = (name: string, exposed: boolean) => `bounded context ${name}
in bounded context ${name} {
    aggregate X {
        root entity X {
            identifier id: Id
        }
        value object Id { raw: string }
    }
    module A {
        ${exposed ? 'exposes B' : ''}
        module B {
            exposes R
            repository R {
                manages X.X
            }
        }
    }
    application service App {
        method run() {
            reads from __CURSOR__
        }
    }
}`;
        const hiddenText = source('Hidden', false);
        const exposedText = source('Exposed', true);
        const hidden = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-source-hidden-root.tni'), hiddenText.replace('__CURSOR__', '')
        );
        const exposed = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-source-exposed-root.tni'), exposedText.replace('__CURSOR__', '')
        );
        documents.push(hidden, exposed);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const completeAt = async (document: LangiumDocument, offset: number) =>
            services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });

        const hiddenItems = await completeAt(hidden, hiddenText.indexOf('__CURSOR__'));
        expect(hiddenItems?.items.map(item => item.label)).not.toContain('A');

        const exposedItems = await completeAt(exposed, exposedText.indexOf('__CURSOR__'));
        expect(exposedItems?.items.map(item => item.label)).toContain('A');
        expect(exposedItems?.items.find(item => item.label === 'A')?.textEdit?.newText).toBe('A.');
    });

    test('offers read models for projector targets with read-model icons', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            read model OrderSummary { status: string }
            event OrderPlaced
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) { projects   }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('projects  ') + 'projects '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.find(item => item.label === 'OrderSummary')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringContaining('OrderSummary')
        });
    });

    test('offers entity fields and enum members in transition clauses', async () => {
        const text = `bounded context Shipping in bounded context Shipping {
            aggregate Shipment {
                root entity Shipment {
                    method ship() { transition status from  to Shipped }
                    identifier id: ShipmentId
                    status: ShipmentStatus
                }
                value object ShipmentId { raw: string }
                enum ShipmentStatus { Open, Shipped }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/transition-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const transition = text.indexOf('transition status');
        const fieldItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(transition + 'transition sta'.length)
        });
        expect(fieldItems?.items.find(item => item.label === 'status')).toMatchObject({
            kind: CompletionItemKind.Field,
            detail: expect.stringContaining('.status:')
        });

        const enumValueOffset = text.indexOf('from  to') + 'from '.length;
        const valueItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(enumValueOffset)
        });
        expect(valueItems?.items.find(item => item.label === 'Open')).toMatchObject({
            kind: CompletionItemKind.EnumMember,
            detail: expect.stringContaining('.Open')
        });
        expect(valueItems?.items.map(item => item.label)).not.toContain('Shipped');
    });

    test('completes each transition change from its own enum field', async () => {
        const fieldText = `bounded context Shipping in bounded context Shipping {
            aggregate Shipment {
                root entity Shipment {
                    method ship() {
                        transition status from Open to Shipped,  from Pending to Confirmed
                    }
                    identifier id: ShipmentId
                    status: ShipmentStatus
                    paymentStatus: PaymentStatus
                }
                value object ShipmentId { raw: string }
                enum ShipmentStatus { Open, Shipped }
                enum PaymentStatus { Pending, Confirmed }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiple-transition-change-completion.tni'), fieldText
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const secondFieldOffset = fieldText.indexOf('Shipped,  ') + 'Shipped,  '.length;
        const fieldCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(secondFieldOffset)
        });
        expect(fieldCompletion?.items.map(item => item.label)).toContain('paymentStatus');
        expect(fieldCompletion?.items.map(item => item.label)).not.toContain('status');
        expect(fieldCompletion?.items.map(item => item.label)).not.toContain('id');
        for (const sibling of ['when', 'invariant', 'precondition', 'postcondition', 'behavior', 'invokes', 'transition', 'emits', 'projects']) {
            expect(fieldCompletion?.items.map(item => item.label), `after transition comma: ${sibling}`).not.toContain(sibling);
        }

        const stateText = fieldText.replace('Shipped,  from', 'Shipped, paymentStatus from');
        const stateDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiple-transition-change-state-completion.tni'), stateText
        );
        documents.push(stateDocument);
        await services.shared.workspace.DocumentBuilder.build([stateDocument], { validation: false });
        const secondFromOffset = stateText.indexOf('paymentStatus from ') + 'paymentStatus from '.length;
        const fromCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(stateDocument, {
            textDocument: { uri: stateDocument.uri.toString() },
            position: stateDocument.textDocument.positionAt(secondFromOffset)
        });
        expect(fromCompletion?.items.map(item => item.label)).toContain('Pending');
        expect(fromCompletion?.items.map(item => item.label)).not.toContain('Open');
        expect(fromCompletion?.items.map(item => item.label)).not.toContain('Shipped');

        const toOffset = stateText.indexOf('paymentStatus from Pending to ') + 'paymentStatus from Pending to '.length;
        const toCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(stateDocument, {
            textDocument: { uri: stateDocument.uri.toString() },
            position: stateDocument.textDocument.positionAt(toOffset)
        });
        expect(toCompletion?.items.map(item => item.label)).toContain('Confirmed');
        expect(toCompletion?.items.map(item => item.label)).not.toContain('Pending');
    });

    test('suggests when guards after transitions, emissions, method invocations, and journey steps', async () => {
        const marker = '__completion_position__';
        const common = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method validate()
                    method place() { CLAUSE }
                    identifier id: OrderId
                    status: OrderStatus
                    paymentStatus: PaymentStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
                enum PaymentStatus { Pending, Confirmed }
            }
            event OrderPlaced
            application service OrderApplication {
                method placeOrder() {}
            }
        }`;
        const cases = [
            {
                name: 'transition',
                expected: ['when'],
                text: common.replace('CLAUSE', `transition status from Draft to Placed ${marker}`)
            },
            {
                name: 'emission',
                expected: ['when'],
                text: common.replace('CLAUSE', `emits OrderPlaced ${marker}`)
            },
            {
                name: 'method invocation',
                expected: ['when'],
                text: common.replace('CLAUSE', `invokes validate ${marker}`)
            },
            {
                name: 'journey step',
                expected: ['when'],
                text: `actor Customer
                    ${common.replace('CLAUSE', '')}
                    journey PlaceOrder { by Customer { invoke Ordering.OrderApplication.placeOrder with "Order input" ${marker} } }`
            },
            {
                name: 'journey step argument contains the word when',
                expected: ['when'],
                text: `actor Customer
                    ${common.replace('CLAUSE', '')}
                    journey PlaceOrder { by Customer { invoke Ordering.OrderApplication.placeOrder with "Choose when ready" ${marker} } }`
            },
            {
                name: 'journey step clauses',
                expected: ['with', 'when'],
                text: `actor Customer
                    ${common.replace('CLAUSE', '')}
                    journey PlaceOrder { by Customer { invoke Ordering.OrderApplication.placeOrder ${marker} } }`
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.text.indexOf(marker);
            const text = completionCase.text.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/when-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            expect(document.parseResult.parserErrors, completionCase.name).toEqual([]);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            for (const keyword of completionCase.expected) {
                expect(completion?.items.map(item => item.label), completionCase.name).toContain(keyword);
            }
        }

        const partialText = common.replace('CLAUSE', 'invokes validate w');
        const partialDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/when-prefix-completion.tni'), partialText
        );
        documents.push(partialDocument);
        await services.shared.workspace.DocumentBuilder.build([partialDocument], { validation: false });
        const partialOffset = partialText.indexOf('invokes validate w') + 'invokes validate w'.length;
        const partialCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(partialDocument, {
            textDocument: { uri: partialDocument.uri.toString() },
            position: partialDocument.textDocument.positionAt(partialOffset)
        });
        const whenItem = partialCompletion?.items.find(item => item.label === 'when');
        expect(whenItem?.textEdit).toMatchObject({
            newText: 'when',
            range: {
                start: partialDocument.textDocument.positionAt(partialOffset - 1),
                end: partialDocument.textDocument.positionAt(partialOffset)
            }
        });
    });

    test('does not offer optional clauses after method effects disallowed for their owner', async () => {
        const marker = '__completion_position__';
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order {
                    identifier id: OrderId
                    status: OrderStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
            }
            event OrderPlaced
            query service OrderQueries {
                method findOrder() returns string { emits OrderPlaced ${marker} }
            }
            domain service Pricing { method calculate() returns number }
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) { invokes Pricing.calculate ${marker} }
            }
            application service OrderCommands {
                method place() { transition status from Draft to Placed ${marker} }
            }
        }
        actor Customer
        journey ReadOrder {
            by Customer { invoke Ordering.OrderQueries.findOrder ${marker} }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/disallowed-optional-specification-clauses.tni'), text.split(marker).join('')
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        let searchFrom = 0;
        for (const source of [
            'emits OrderPlaced ',
            'invokes Pricing.calculate ',
            'transition status from Draft to Placed ',
            'invoke Ordering.OrderQueries.findOrder '
        ]) {
            const offset = text.indexOf(source, searchFrom) + source.length;
            searchFrom = offset;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label), source).not.toContain('when');
            if (source.startsWith('invoke ')) {
                expect(completion?.items.map(item => item.label), source).not.toContain('with');
            }
        }
    });

    test('offers required transition and emission continuations before optional guards', async () => {
        const marker = '__completion_position__';
        const common = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place() { CLAUSE }
                    identifier id: OrderId
                    status: OrderStatus
                    paymentStatus: PaymentStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
                enum PaymentStatus { Pending, Confirmed }
            }
            event OrderPlaced
        }`;
        const cases = [
            {
                name: 'transition field requires from',
                clause: `transition status ${marker}`,
                expected: ['from'],
                forbidden: ['when']
            },
            {
                name: 'transition source state requires to',
                clause: `transition status from Draft ${marker}`,
                expected: ['to'],
                forbidden: ['when']
            },
            {
                name: 'partial destination state does not allow when',
                clause: `transition status from Draft to Pl${marker}`,
                expected: ['Placed'],
                forbidden: ['when']
            },
            {
                name: 'partial when after a forward-declared transition field and state',
                clause: `transition status from Draft to Placed w${marker}`,
                expected: ['when'],
                forbidden: []
            },
            {
                name: 'transition comma requires another field before when',
                clause: `transition status from Draft to Placed, ${marker}`,
                expected: ['paymentStatus'],
                forbidden: ['when']
            },
            {
                name: 'emission requires an event before when',
                clause: `emits ${marker}`,
                expected: ['OrderPlaced'],
                forbidden: ['when']
            },
            {
                name: 'partial event name does not allow when',
                clause: `emits OrderP${marker}`,
                expected: ['OrderPlaced'],
                forbidden: ['when']
            },
            {
                name: 'complete emission allows when',
                clause: `emits OrderPlaced ${marker}`,
                expected: ['when'],
                forbidden: []
            },
            {
                name: 'partially typed when after a forward-declared event',
                clause: `emits OrderPlaced w${marker}`,
                expected: ['when'],
                forbidden: []
            },
            {
                name: 'does not repeat a fully typed when keyword',
                clause: `emits OrderPlaced when${marker}`,
                expected: [],
                forbidden: ['when']
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const text = common.replace('CLAUSE', completionCase.clause);
            const offset = text.indexOf(marker);
            const source = text.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/required-operation-continuation-${index}.tni`), source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const label of completionCase.expected) {
                expect(labels, completionCase.name).toContain(label);
            }
            for (const label of completionCase.forbidden) {
                expect(labels, completionCase.name).not.toContain(label);
            }
            if (completionCase.name === 'partial when after a forward-declared transition field and state') {
                const whenItem = completion?.items.find(item => item.label === 'when');
                expect(whenItem?.textEdit).toMatchObject({
                    newText: 'when',
                    range: {
                        start: document.textDocument.positionAt(offset - 1),
                        end: document.textDocument.positionAt(offset)
                    }
                });
            }
            if (completionCase.name === 'partially typed when after a forward-declared event') {
                const whenItem = completion?.items.find(item => item.label === 'when');
                expect(whenItem?.textEdit).toMatchObject({
                    newText: 'when',
                    range: {
                        start: document.textDocument.positionAt(offset - 1),
                        end: document.textDocument.positionAt(offset)
                    }
                });
            }
        }
    });

    test('offers transition continuations only for enum fields in entity methods', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'application-service method',
                source: `bounded context Ordering\nin bounded context Ordering { application service App { method run() { transition status f${marker} } } }`
            },
            {
                name: 'non-enum entity field',
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method run() { transition status f${marker} } status: string } } }`
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const source = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/invalid-transition-continuation-${index}.tni`), source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label), completionCase.name).not.toContain('from');
        }
    });

    test('inserts optional clauses with required spacing at a completed path', async () => {
        const text = `bounded context Ordering
        in bounded context Ordering {
            application service OrderApplication {
                method validate()
                method placeOrder() {
                    invokes validate
                }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/optional-clause-spacing.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const offset = text.indexOf('invokes validate') + 'invokes validate'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('when');
        expect(labels).toContain('invokes');
        expect(labels).not.toContain('emits');
        expect(completion?.items.find(item => item.label === 'invokes')?.detail).toBe('Language keyword');
        expect(completion?.items.find(item => item.label === 'when')?.textEdit).toMatchObject({
            newText: ' when',
            range: { start: document.textDocument.positionAt(offset), end: document.textDocument.positionAt(offset) }
        });
    });

    test('suggests optional keywords at their grammar positions', async () => {
        const marker = '__completion_position__';
        const cases = [
            { name: 'bounded-context realizes', keyword: 'realizes', source: `subdomain Commerce\nbounded context Ordering ${marker}` },
            { name: 'subdomain kind', keyword: 'kind', source: `subdomain Commerce ${marker}` },
            { name: 'module dependencies', keyword: 'depends on', source: `bounded context Ordering\nin bounded context Ordering { module Api ${marker} {} }` },
            { name: 'value-object mirrors', keyword: 'mirrors', source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { value object Base { raw: string }\nvalue object Mirror ${marker} { raw: string } } }` },
            { name: 'method return type', keyword: 'returns', source: `bounded context Ordering\nin bounded context Ordering { application service Queries { method find() ${marker} } }` },
            { name: 'field initial state', keyword: 'initial', source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { identifier id: Id\nstatus: Status ${marker} }\nvalue object Id { raw: string }\nenum Status { Draft, Placed } } }` }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const text = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/optional-keyword-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            expect(document.parseResult.parserErrors, completionCase.name).toHaveLength(0);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label), completionCase.name).toContain(completionCase.keyword);
        }
    });

    test('offers only realizes before a newline after a bounded-context declaration', async () => {
        const sameLineText = 'bounded context Ordering ';
        const sameLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/realizes-same-line-completion.tni'), sameLineText
        );
        documents.push(sameLine);
        const sameLinePosition = sameLine.textDocument.positionAt(sameLineText.length);
        const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sameLine, {
            textDocument: { uri: sameLine.uri.toString() },
            position: sameLinePosition
        });
        expect(sameLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'realizes', 'bounded context', 'subdomain', 'context map'
        ]));

        const nextLineText = 'bounded context Ordering\n';
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/realizes-next-line-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.length)
        });
        const nextLineLabels = nextLineCompletion?.items.map(item => item.label) ?? [];
        expect(nextLineLabels).toContain('realizes');
        expect(nextLineLabels).toContain('bounded context');
        expect(nextLineLabels).toContain('in bounded context');
    });

    test('keeps required keyword continuations available on the same line', async () => {
        const cases = [
            { name: 'bounded context', source: 'bounded ', expected: ['context'] },
            { name: 'in bounded context', source: 'in bounded ', expected: ['context'] },
            { name: 'context map', source: 'context ', expected: ['map'] },
            { name: 'shared kernel', source: 'shared ', expected: ['kernel'] },
            { name: 'application service', source: 'bounded context X\nin bounded context X {\napplication ', expected: ['service'] },
            { name: 'domain service', source: 'bounded context X\nin bounded context X {\ndomain ', expected: ['service'] },
            { name: 'read model', source: 'bounded context X\nin bounded context X {\nread ', expected: ['model'] },
            { name: 'data object', source: 'bounded context X\nin bounded context X {\ndata ', expected: ['object'] },
            { name: 'value object', source: 'bounded context X\nin bounded context X { aggregate A {\nvalue ', expected: ['object'] },
            { name: 'root entity', source: 'bounded context X\nin bounded context X { aggregate A {\nroot ', expected: ['entity'] },
            { name: 'query service and repository', source: 'bounded context X\nin bounded context X {\nquery ', expected: ['repository', 'service'] },
            { name: 'integration event', source: 'bounded context X\nin bounded context X {\nintegration ', expected: ['event'] },
            { name: 'module depends on', source: 'bounded context X\nin bounded context X {\nmodule M depends ', expected: ['on'] },
            { name: 'repository manages', source: 'bounded context X\nin bounded context X {\nrepository R { ', expected: ['manages'] },
            { name: 'query repository serves', source: 'bounded context X\nin bounded context X {\nquery repository R { ', expected: ['serves'] },
            { name: 'import from', source: 'import { Foo } ', expected: ['from'] }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/keyword-continuation-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const position = document.textDocument.positionAt(completionCase.source.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const expected of completionCase.expected) {
                expect(labels, completionCase.name).toContain(expected);
            }
        }
    });

    test('completes subdomain kind values and partial values', async () => {
        const cases = [
            { source: 'subdomain Commerce kind ', expected: ['core', 'supporting', 'generic'] },
            { source: 'subdomain Commerce kind s', expected: ['supporting'] }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/subdomain-kind-completion-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const expected of completionCase.expected) {
                expect(labels, completionCase.source).toContain(expected);
                expect(labels.filter(label => label === expected), `${completionCase.source}: ${expected}`).toHaveLength(1);
            }
            if (completionCase.source.endsWith('kind s')) {
                expect(completion?.items.find(item => item.label === 'supporting')?.textEdit).toMatchObject({
                    newText: 'supporting',
                    range: {
                        start: document.textDocument.positionAt(completionCase.source.length - 1),
                        end: document.textDocument.positionAt(completionCase.source.length)
                    }
                });
            }
        }
    });

    test('completes partial multiword keywords and replaces only their typed prefix', async () => {
        const cases = [
            ['bounded c', 'context'],
            ['in bounded c', 'context'],
            ['shared k', 'kernel'],
            ['application s', 'service'],
            ['domain s', 'service'],
            ['query r', 'repository'],
            ['query s', 'service'],
            ['read m', 'model'],
            ['data o', 'object'],
            ['value o', 'object'],
            ['bounded context X\nin bounded context X { aggregate A { root e', 'entity'],
            ['integration e', 'event'],
            ['depends o', 'on'],
            ['context m', 'map'],
            ['import { Foo } f', 'from'],
            ['repository Orders { m', 'manages'],
            ['query repository Orders { s', 'serves'],
            ['bounded context X\nin bounded context X { application service A { method run() { reads f', 'reads from'],
            ['bounded context X\nin bounded context X { application service A { method run() { reads from OrderRepository w', 'when'],
            ['bounded context Ordering\nin bounded context Ordering { aggregate Order { enum Status { Draft, Placed } root entity Order { status: Status method place() { transition status f', 'from'],
            ['bounded context Ordering\nin bounded context Ordering { aggregate Order { enum Status { Draft, Placed } root entity Order { status: Status method place() { transition status from Draft t', 'to'],
            ['sharedKernel Common { p', 'participants'],
            ['customer Ordering -> s', 'supplier'],
            ['partner Ordering <-> p', 'partner'],
            ['customer Ordering { i', 'integrationPatterns'],
            ['customer Alpha -> supplier Beta { i', 'integrationPatterns']
        ] as const;

        for (const [index, [source, expected]] of cases.entries()) {
            const text = expected === 'from' || expected === 'to' || expected === 'reads from' ? `${source} } } }` : source;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/partial-keyword-${index}.tni`), text
            );
            documents.push(document);
            if (expected === 'from' || expected === 'to' || expected === 'reads from') {
                await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            }
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.length)
            });
            const item = completion?.items.find(candidate => candidate.label === expected);
            expect(item, source).toBeDefined();
            expect(completion?.items.filter(candidate => candidate.label === expected), source).toHaveLength(1);
            if (expected === 'reads from') {
                expect(item?.textEdit?.newText).toContain('reads from');
                expect(completion?.items.map(candidate => candidate.label)).not.toContain('reads');
                expect(completion?.items.map(candidate => candidate.label)).not.toContain('from');
            } else {
                expect(item?.textEdit).toMatchObject({
                    newText: expected,
                    range: {
                        start: document.textDocument.positionAt(source.length - 1),
                        end: document.textDocument.positionAt(source.length)
                    }
                });
            }
        }
    });

    test('does not suggest integration patterns from comment text', async () => {
        const cases = [
            '// bounded c',
            '/* bounded c',
            'actor Customer /* bounded c */'
        ];
        for (const [index, text] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/keyword-comment-completion-${index}.tni`), text
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(text.indexOf('bounded c') + 'bounded c'.length)
            });
            expect(completion?.items, text).toEqual([]);
        }
    });

    test('completes repository block statements and query-repository sources', async () => {
        const marker = '__cursor__';
        const cases = [
            {
                name: 'write repository in an empty block',
                body: `repository OrderRepository {
                    ${marker}
                }`,
                expected: 'manages'
            },
            {
                name: 'query repository in an empty block',
                body: `query repository OrderSummaryRepository {
                    ${marker}
                }`,
                expected: 'serves'
            },
            {
                name: 'query repository source after serves',
                body: `query repository OrderSummaryRepository {
                    serves OrderSummary
                    ${marker}
                }`,
                expected: 'reads from'
            },
            {
                name: 'query repository source after serves on the same line',
                body: `query repository OrderSummaryRepository { serves OrderSummary${marker} }`,
                expected: 'reads from'
            },
            {
                name: 'query repository source after a partially typed served model',
                body: `query repository OrderSummaryRepository {
                    serves OrderSumm${marker}
                }`,
                expected: 'OrderSummary'
            },
            {
                name: 'query repository reads continuation',
                body: `query repository OrderSummaryRepository {
                    serves OrderSummary
                    reads ${marker}
                }`,
                expected: 'reads from'
            },
            {
                name: 'aggregate sources for a query repository',
                body: `query repository OrderSummaryRepository {
                    serves OrderSummary
                    reads from ${marker}
                }`,
                expected: 'Order'
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const source = `bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                read model OrderSummary { status: string }
                ${completionCase.body}
            }`;
            const offset = source.indexOf(marker);
            const text = source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/repository-block-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, `${completionCase.name}: ${completion?.items.map(candidate => candidate.label).join(', ')}`).toBeDefined();
            if (completionCase.name === 'query repository in an empty block') {
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads from');
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads');
                expect(isQueryRepositoryReadCompletionPosition(document, offset)).toBe(false);
            }
            if (completionCase.name === 'query repository source after serves') {
                expect(isQueryRepositoryReadCompletionPosition(document, offset)).toBe(true);
            }
            if (completionCase.name === 'query repository source after serves' ||
                completionCase.name === 'query repository source after serves on the same line' ||
                completionCase.name === 'query repository source after a partially typed served model') {
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads');
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('from');
            }
            if (completionCase.name === 'query repository reads continuation') {
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads');
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('from');
            }
            if (['manages', 'serves', 'reads', 'from', 'reads from'].includes(completionCase.expected)) {
                expect(item?.kind, completionCase.name).toBe(CompletionItemKind.Keyword);
                if (completionCase.expected === 'reads from') {
                    const edit = item?.textEdit;
                    expect(edit?.newText, completionCase.name).toMatch(/^\s*reads from$/u);
                    const editRange = edit && 'range' in edit ? edit.range : undefined;
                    expect(editRange).toBeDefined();
                    expect(editRange?.start.line, completionCase.name).toBe(editRange?.end.line);
                    if (completionCase.name === 'query repository source after serves on the same line' ||
                        completionCase.name === 'query repository source after a partially typed served model') {
                        expect(edit?.newText, completionCase.name).toMatch(/^\r?\n\s+reads from$/u);
                    }
                } else {
                    expect(item?.textEdit?.newText, completionCase.name).toContain(completionCase.expected);
                }
            }
            if (completionCase.expected === 'Order') {
                expect(completion?.items.map(item => item.label), completionCase.name).not.toContain('OrderRepository');
                expect(item?.kind).toBe(CompletionItemKind.Class);
                expect(item?.textEdit).toMatchObject({
                    newText: 'Order',
                    range: {
                        start: document.textDocument.positionAt(offset),
                        end: document.textDocument.positionAt(offset)
                    }
                });
            }
        }
    });

    test('does not leak enclosing keywords after a query repository read source', async () => {
        const marker = '__cursor__';
        const source = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            read model OrderSummary {
                status: string
            }
            query repository OrderSummaryRepository {
                serves OrderSummary
                reads from Order
                ${marker}
            }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/query-repository-read-sibling-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        expect(isQueryRepositoryReadCompletionPosition(document, offset)).toBe(false);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        const forbidden = [
            'aggregate', 'application service', 'domain service', 'projector', 'query repository',
            'query service', 'read model', 'repository', 'behavior', 'invokes', 'reads from', 'projects'
        ];
        expect(labels.filter(label => forbidden.includes(String(label)))).toEqual([]);
    });

    test('does not treat a closed query repository as active in a later aggregate block', async () => {
        const marker = '__cursor__';
        const source = `bounded context Ordering in bounded context Ordering {
            read model OrderSummary { status: string }
            query repository OrderSummaryRepository { serves OrderSummary }
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
                ${marker}
            }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/closed-query-repository-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('entity');
        expect(labels).not.toContain('reads from');
    });

    test('completes partially typed optional continuations', async () => {
        const cases = [
            { source: 'bounded context Ordering r', expected: 'realizes', typed: 'r' },
            { source: 'subdomain Commerce k', expected: 'kind', typed: 'k' },
            { source: 'bounded context Ordering\nin bounded context Ordering {\n    module Api d\n}', expected: 'depends', typed: 'd' },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        value object Mirror m { raw: string }\n    }\n}',
                expected: 'mirrors',
                typed: 'm'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        root entity Order {\n            status: Status i\n        }\n        enum Status { Draft, Placed }\n    }\n}',
                expected: 'initial',
                typed: 'i'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    application service Queries {\n        method find() r\n    }\n}',
                expected: 'returns',
                typed: 'r'
            },
            { source: 'bounded context Ordering\nr', expected: 'realizes', typed: 'r' },
            { source: 'subdomain Commerce\nk', expected: 'kind', typed: 'k' },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    module Api\n    d\n}',
                expected: 'depends',
                typed: 'd'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        value object Mirror\n        m { raw: string }\n    }\n}',
                expected: 'mirrors',
                typed: 'm'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    application service Queries {\n        method find()\n        r\n    }\n}',
                expected: 'returns',
                typed: 'r'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        root entity Order {\n            status: Status\n            i\n        }\n        enum Status { Draft, Placed }\n    }\n}',
                expected: 'initial',
                typed: 'i'
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/partial-optional-continuation-${index}.tni`), completionCase.source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const prefixStart = completionCase.source.lastIndexOf(completionCase.typed);
            const position = document.textDocument.positionAt(prefixStart + completionCase.typed.length);
            if (completionCase.expected === 'initial') {
                const provider = services.Thinai.lsp.CompletionProvider as unknown as {
                    getPartialInitialKeywordCompletions(document: LangiumDocument, position: import('vscode-languageserver').Position): CompletionItem[];
                };
                expect(provider.getPartialInitialKeywordCompletions(document, position)).not.toEqual([]);
            }
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({
                range: { start: document.textDocument.positionAt(prefixStart), end: position },
                newText: completionCase.expected
            });
        }
    });

    test('suggests bounded contexts without context-map keywords in relationship endpoints', async () => {
        const cases = [
            { name: 'customer-supplier supplier', relationship: 'customer Alpha -> supplier ' },
            { name: 'partnership right', relationship: 'partner Alpha <-> partner ' },
            { name: 'separate ways right', relationship: 'separateWays Alpha -x- ' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-endpoint-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(text.indexOf(completionCase.relationship) + completionCase.relationship.length)
            });
            const labels = completion?.items.map(item => item.label) ?? [];

            expect(labels, completionCase.name).not.toContain('Alpha');
            expect(labels, completionCase.name).toContain('Beta');
            expect(completion?.items.every(item => item.detail?.startsWith('BoundedContext ')), completionCase.name)
                .toBe(true);
            for (const keyword of ['customer', 'partner', 'separateWays', 'sharedKernel']) {
                expect(labels, completionCase.name).not.toContain(keyword);
            }
        }

        const emptyMapText = 'context map Relations {\n    \n}';
        const emptyMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-relationship-keyword-completion.tni'), emptyMapText
        );
        documents.push(emptyMap);
        const relationshipKeywords = await services.Thinai.lsp.CompletionProvider?.getCompletion(emptyMap, {
            textDocument: { uri: emptyMap.uri.toString() },
            position: emptyMap.textDocument.positionAt(emptyMapText.indexOf('\n    ') + '\n    '.length)
        });
        expect(relationshipKeywords?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'customer', 'partner', 'separateWays', 'sharedKernel'
        ]));
    });

    test('offers relationship-start keywords after a newline and after a completed same-line relationship', async () => {
        const cases = [
            { name: 'customer-supplier', relationship: 'customer Alpha ' },
            { name: 'partnership', relationship: 'partner Alpha ' },
            { name: 'separate ways', relationship: 'separateWays Alpha ' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/incomplete-context-map-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(text.indexOf(completionCase.relationship) + completionCase.relationship.length)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const keyword of ['customer', 'partner', 'separateWays', 'sharedKernel']) {
                expect(labels, completionCase.name).not.toContain(keyword);
            }
        }

        const completedRelationships = [
            'customer Alpha -> supplier Beta ',
            'partner Alpha <-> partner Beta ',
            'separateWays Alpha -x- Beta ',
            'customer Alpha { integrationPatterns: ["AntiCorruptionLayer"] } -> supplier Beta { integrationPatterns: ["OpenHostService"] } '
        ];
        for (const [index, relationship] of completedRelationships.entries()) {
            const completedLineText = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${relationship}\n}`;
            const completedLine = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-completed-line-completion-${index}.tni`), completedLineText
            );
            documents.push(completedLine);
            await services.shared.workspace.DocumentBuilder.build([completedLine], { validation: false });
            const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(completedLine, {
                textDocument: { uri: completedLine.uri.toString() },
                position: completedLine.textDocument.positionAt(completedLineText.indexOf(relationship) + relationship.length)
            });
            expect(sameLineCompletion?.items.map(item => item.label), relationship).toEqual(expect.arrayContaining([
                'customer', 'partner', 'separateWays', 'sharedKernel'
            ]));
            expect(sameLineCompletion?.items.every(item => item.data?.thinaiSiblingCompletion === true), relationship).toBe(true);
        }

        const nextLineText = 'bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    customer Alpha -> supplier Beta\n    \n}';
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-next-relationship-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.indexOf('\n    \n}') + '\n    '.length)
        });
        expect(nextLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'customer', 'partner', 'separateWays', 'sharedKernel'
        ]));

        const partialKeywords = [
            { relationship: 'customer Alpha -> supplier Beta', prefix: 'c' },
            { relationship: 'partner Alpha <-> partner Beta', prefix: 'p' },
            { relationship: 'separateWays Alpha -x- Beta', prefix: 's' },
            { relationship: 'customer Alpha -> supplier Beta { integrationPatterns: ["OpenHostService"] }', prefix: 's' }
        ];
        for (const [index, completionCase] of partialKeywords.entries()) {
            const source = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship} ${completionCase.prefix}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-partial-next-keyword-${index}.tni`), source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.indexOf(`${completionCase.relationship} ${completionCase.prefix}`) + `${completionCase.relationship} ${completionCase.prefix}`.length)
            });
            expect(completion?.items.some(item => item.data?.thinaiSiblingCompletion === true), completionCase.relationship).toBe(true);
            expect(completion?.items.find(item => item.data?.thinaiSiblingCompletion === true)?.textEdit?.newText)
                .toMatch(/^\n\s+/u);
        }
    });

    test('suggests the relationship operator and required counterpart after the left context', async () => {
        const cases = [
            { relationship: 'customer Alpha ', continuation: '-> supplier' },
            { relationship: 'customer Alpha { integrationPatterns: ["AntiCorruptionLayer"] }\n    ', continuation: '-> supplier' },
            { relationship: 'partner Alpha ', continuation: '<-> partner' },
            { relationship: 'partner Alpha { integrationPatterns: ["Conformist"] }\n    ', continuation: '<-> partner' },
            { relationship: 'separateWays Alpha ', continuation: '-x-' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-operator-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

            const position = document.textDocument.positionAt(
                text.indexOf(completionCase.relationship) + completionCase.relationship.length
            );
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.continuation);

            expect(item, completionCase.relationship).toMatchObject({
                kind: CompletionItemKind.Operator,
                detail: 'Context-map relationship continuation',
                textEdit: {
                    range: { start: position, end: position },
                    newText: `${completionCase.continuation} `
                }
            });
        }
    });

    test('triggers right-side completions directly after relationship symbols', async () => {
        const keywordCases = [
            { prefix: 'customer Alpha ->', keyword: 'supplier', newText: ' supplier' },
            { prefix: 'partner Alpha <->', keyword: 'partner', newText: ' partner' }
        ];

        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toEqual(
            expect.arrayContaining(['>', '-'])
        );

        for (const [index, completionCase] of keywordCases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.prefix}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-right-keyword-after-symbol-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const position = document.textDocument.positionAt(text.indexOf(completionCase.prefix) + completionCase.prefix.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            expect(completion?.items.find(item => item.label === completionCase.keyword)).toMatchObject({
                kind: CompletionItemKind.Keyword,
                textEdit: {
                    range: { start: position, end: position },
                    newText: completionCase.newText
                }
            });
        }

        const separateWaysText = 'bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    separateWays Alpha -x-\n}';
        const separateWays = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-right-context-after-symbol.tni'), separateWaysText
        );
        documents.push(separateWays);
        await services.shared.workspace.DocumentBuilder.build([separateWays], { validation: false });
        const separateWaysPosition = separateWays.textDocument.positionAt(separateWaysText.indexOf('separateWays Alpha -x-') + 'separateWays Alpha -x-'.length);
        const contextCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(separateWays, {
            textDocument: { uri: separateWays.uri.toString() },
            position: separateWaysPosition
        });
        expect(contextCompletion?.items.map(item => item.label)).toContain('Beta');
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('Alpha');
        expect(contextCompletion?.items.find(item => item.label === 'Beta')).toMatchObject({
            kind: CompletionItemKind.Module,
            detail: 'BoundedContext Beta',
            textEdit: {
                range: { start: separateWaysPosition, end: separateWaysPosition },
                newText: ' Beta'
            }
        });
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('customer');
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('partner');
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('sharedKernel');

        const rightContextCases = [
            'customer Alpha -> supplier',
            'partner Alpha <-> partner'
        ];
        for (const [index, relationship] of rightContextCases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-right-context-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const position = document.textDocument.positionAt(text.indexOf(relationship) + relationship.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            expect(completion?.items.map(item => item.label), relationship).toContain('Beta');
            expect(completion?.items.map(item => item.label), relationship).not.toContain('Alpha');
        }

        const multilineRightContexts = [
            `customer Alpha {\n        integrationPatterns: ["AntiCorruptionLayer"]\n    } -> supplier`,
            `partner Alpha {\n        integrationPatterns: ["Conformist"]\n    } <-> partner`,
            `separateWays Alpha\n    -x-`
        ];
        for (const [index, relationship] of multilineRightContexts.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-multiline-right-context-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const position = document.textDocument.positionAt(text.indexOf(relationship) + relationship.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            expect(completion?.items.map(item => item.label), relationship).toContain('Beta');
            expect(completion?.items.map(item => item.label), relationship).not.toContain('Alpha');
        }
    });

    test('inserts multiword keywords as complete phrases', async () => {
        const cases = [
            { source: '', label: 'shared kernel' },
            { source: '', label: 'bounded context' },
            { source: 'bounded context X\nin bounded context X { aggregate A { ', label: 'value object' }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/compound-keyword-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.label);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({ newText: completionCase.label });
        }
    });

    test('offers top-level sibling keywords from a completed declaration on the same line', async () => {
        const sameLineText = 'bounded context Ordering realizes OrderManagement ';
        const sameLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-same-line-completion.tni'), sameLineText
        );
        documents.push(sameLine);
        const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sameLine, {
            textDocument: { uri: sameLine.uri.toString() },
            position: sameLine.textDocument.positionAt(sameLineText.length)
        });
        const siblingKeywords = ['bounded context', 'subdomain', 'context map'];
        for (const keyword of siblingKeywords) {
            expect(sameLineCompletion?.items.map(item => item.label)).toContain(keyword);
            const item = sameLineCompletion?.items.find(candidate => candidate.label === keyword);
            expect(item?.detail).toBe('Language keyword');
            expect(item?.data?.thinaiSiblingCompletion).toBe(true);
            expect(item?.textEdit).toMatchObject({
                range: {
                    start: sameLine.textDocument.positionAt(sameLineText.trimEnd().length),
                    end: sameLine.textDocument.positionAt(sameLineText.length)
                },
                newText: `\n${keyword}`
            });
        }

        const partialSiblingText = `${sameLineText.trimEnd()} bounded `;
        const partialSibling = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-partial-sibling-same-line-completion.tni'), partialSiblingText
        );
        documents.push(partialSibling);
        const partialSiblingCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(partialSibling, {
            textDocument: { uri: partialSibling.uri.toString() },
            position: partialSibling.textDocument.positionAt(partialSiblingText.length)
        });
        const partialSiblingItem = partialSiblingCompletion?.items.find(item => item.label === 'bounded context');
        expect(partialSiblingItem?.detail).toBe('Language keyword');
        expect(partialSiblingItem?.data?.thinaiSiblingCompletion).toBe(true);
        expect(partialSiblingItem?.textEdit).toMatchObject({
            range: {
                start: partialSibling.textDocument.positionAt(sameLineText.trimEnd().length),
                end: partialSibling.textDocument.positionAt(partialSiblingText.length)
            },
            newText: '\nbounded context'
        });

        const crlfText = 'subdomain Commerce\r\nbounded context Ordering realizes OrderManagement ';
        const crlfDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-crlf-sibling-completion.tni'), crlfText
        );
        documents.push(crlfDocument);
        const crlfCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(crlfDocument, {
            textDocument: { uri: crlfDocument.uri.toString() },
            position: crlfDocument.textDocument.positionAt(crlfText.length)
        });
        expect(crlfCompletion?.items.find(item => item.label === 'bounded context')?.textEdit)
            .toMatchObject({ newText: '\r\nbounded context' });

        const crText = 'subdomain Commerce\rbounded context Ordering realizes OrderManagement ';
        const crDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-cr-sibling-completion.tni'), crText
        );
        documents.push(crDocument);
        const crCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(crDocument, {
            textDocument: { uri: crDocument.uri.toString() },
            position: crDocument.textDocument.positionAt(crText.length)
        });
        expect(crCompletion?.items.find(item => item.label === 'bounded context')?.textEdit)
            .toMatchObject({ newText: '\rbounded context' });

        const nextLineText = `${sameLineText.trimEnd()}\n`;
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-next-line-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.length)
        });
        expect(nextLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining(siblingKeywords));
    });

    test('completes partially typed top-level keywords in declaration gaps', async () => {
        const cases = [
            { source: 'bounded context Ordering realizes Commerce\nb', expected: 'bounded context', typed: 'b' },
            { source: 'bounded context Ordering realizes Commerce\nbounded c', expected: 'context', typed: 'c' },
            { source: 'bounded context Ordering realizes Commerce\nsh', expected: 'shared kernel', typed: 'sh' },
            { source: 'b', expected: 'bounded context', typed: 'b' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/top-level-partial-completion-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({
                newText: completionCase.expected,
                range: {
                    start: document.textDocument.positionAt(completionCase.source.length - completionCase.typed.length),
                    end: document.textDocument.positionAt(completionCase.source.length)
                }
            });
        }
    });

    test('filters partially typed block keywords and replaces only their prefix', async () => {
        const cases = [
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    ag\n}',
                expected: 'aggregate',
                typed: 'ag'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    application s\n}',
                expected: 'service',
                typed: 's'
            },
            {
                source: 'context map Fulfillment {\n    c\n}',
                expected: 'customer',
                typed: 'c'
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/block-partial-completion-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.lastIndexOf(completionCase.typed) + completionCase.typed.length)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({
                newText: completionCase.expected,
                range: {
                    start: document.textDocument.positionAt(completionCase.source.lastIndexOf(completionCase.typed)),
                    end: document.textDocument.positionAt(completionCase.source.lastIndexOf(completionCase.typed) + completionCase.typed.length)
                }
            });
            expect(completion?.items.filter(candidate => candidate.kind === CompletionItemKind.Keyword)
                .every(candidate => completionCase.expected === candidate.label), completionCase.source).toBe(true);
        }
    });

    test('offers context-member sibling suggestions on the same line and after a newline', async () => {
        const sameLineText = 'bounded context Ordering\nin bounded context Ordering {\n    event OrderPlaced \n}';
        const sameLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-member-same-line-completion.tni'), sameLineText
        );
        documents.push(sameLine);
        const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sameLine, {
            textDocument: { uri: sameLine.uri.toString() },
            position: sameLine.textDocument.positionAt(sameLineText.indexOf('event OrderPlaced') + 'event OrderPlaced '.length)
        });
        expect(sameLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'aggregate', 'application service', 'module', 'value object'
        ]));
        const sameLineSibling = sameLineCompletion?.items.find(item => item.label === 'aggregate');
        expect(sameLineSibling?.kind).toBe(CompletionItemKind.Keyword);
        expect(sameLineSibling?.data).toMatchObject({ thinaiIndentationDepth: 1 });
        expect(sameLineSibling?.textEdit).toMatchObject({ newText: '\n    aggregate' });
        expect(applyConfiguredIndentationToCompletions([sameLineSibling!], 2, false)[0]?.textEdit?.newText)
            .toBe('\n\taggregate');

        const nextLineText = 'bounded context Ordering\nin bounded context Ordering {\n    event OrderPlaced\n    \n}';
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-member-next-line-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.indexOf('\n    \n}') + '\n    '.length)
        });
        expect(nextLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'aggregate', 'application service', 'module', 'value object'
        ]));
    });

    test('waits for a statement boundary while typing a bare declaration name', async () => {
        const declaration = 'bounded context Ordering\nin bounded context Ordering { domain service Curr';
        const inName = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/sibling-completion-at-domain-service-name.tni'), declaration
        );
        documents.push(inName);
        const inNameCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(inName, {
            textDocument: { uri: inName.uri.toString() },
            position: inName.textDocument.positionAt(declaration.length)
        });
        expect(inNameCompletion?.items.some(item => item.data?.thinaiSiblingCompletion === true)).toBe(false);

        const completeDeclaration = `${declaration.replace(/Curr$/u, 'Currency')} `;
        const afterName = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/sibling-completion-after-domain-service-name.tni'), completeDeclaration
        );
        documents.push(afterName);
        const afterNameCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(afterName, {
            textDocument: { uri: afterName.uri.toString() },
            position: afterName.textDocument.positionAt(completeDeclaration.length)
        });
        expect(afterNameCompletion?.items.some(item => item.data?.thinaiSiblingCompletion === true)).toBe(true);
        expect(afterNameCompletion?.items.map(item => item.label)).toContain('value object');
    });

    test('does not offer same-line siblings while the current field or method is incomplete', async () => {
        const cases = [
            {
                source: 'shared kernel CommonTypes { value object Currency { raw: string amount: str',
                name: 'incomplete field type',
                forbidden: ['constructor', 'method']
            },
            {
                source: 'shared kernel CommonTypes { value object Currency { raw: string method normalize',
                name: 'incomplete method signature',
                forbidden: ['constructor', 'method']
            },
            {
                source: 'shared kernel CommonTypes { value object Currency',
                name: 'incomplete value-object declaration',
                forbidden: ['enum', 'domain service', 'module']
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering { module Api { exposes',
                name: 'incomplete exposure',
                forbidden: ['aggregate', 'application service', 'value object']
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering { repository OrderRepository {',
                name: 'repository without manages target',
                forbidden: ['aggregate', 'application service', 'value object']
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering { query repository OrderQueries {',
                name: 'query repository without serves target',
                forbidden: ['aggregate', 'application service', 'value object']
            },
            {
                source: 'shared kernel CommonTypes { value object Currency { raw: string method normalize() { behavior "Normalize',
                name: 'unfinished behavior text',
                forbidden: ['invariant', 'precondition', 'postcondition', 'behavior', 'transition', 'invokes', 'emits']
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/incomplete-same-line-sibling-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            expect(completion?.items.filter(item => item.data?.thinaiSiblingCompletion === true).map(item => item.label), completionCase.name)
                .toEqual([]);
            for (const label of completionCase.forbidden) {
                expect(completion?.items.map(item => item.label), completionCase.name).not.toContain(label);
            }
        }
    });

    test('does not repeat the method keyword while its declaration is being typed', async () => {
        const sources = [
            'shared kernel CommonTypes {\n  value object Currency {\n    method ',
            'shared kernel CommonTypes {\n  value object Currency {\n    method normal'
        ];
        for (const [index, source] of sources.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/method-keyword-not-repeated-${index}.tni`), source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.length)
            });
            expect(completion?.items.map(item => item.label), source).not.toContain('method');
        }
    });

    test('does not suggest method-body siblings before invocation, emission, or transition syntax is complete', async () => {
        const cases = [
            {
                name: 'invocation without a target',
                source: 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { invokes'
            },
            {
                name: 'emission without an event',
                source: 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { emits'
            },
            {
                name: 'transition missing a destination state',
                source: 'bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method change() { transition status from Draft to'
            },
            {
                name: 'read dependency without a source',
                source: 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { reads from'
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/incomplete-method-sibling-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            expect(completion?.items.some(item => item.data?.thinaiSiblingCompletion === true), completionCase.name)
                .toBe(false);
            for (const sibling of ['invariant', 'emits', 'transition', 'invokes', 'projects', 'reads from']) {
                expect(completion?.items.map(item => item.label), completionCase.name).not.toContain(sibling);
            }
        }
    });

    test('indents sibling completions by structural nesting when existing statements are inline', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering { aggregate Order { value object OrderId { raw: string } ';
        const source = `${prefix}} }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/inline-nested-sibling-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        expect(completion?.items.map(item => item.label)).toContain('enum');
        const enumCompletion = completion?.items.find(item => item.label === 'enum');
        expect(enumCompletion?.detail).toBe('Language keyword');
        expect(enumCompletion?.data?.thinaiSiblingCompletion).toBe(true);
        expect(enumCompletion?.insertTextMode).toBe(InsertTextMode.asIs);
        expect(enumCompletion?.data).toMatchObject({ thinaiIndentationDepth: 2 });
        expect(enumCompletion?.textEdit)
            .toMatchObject({
                range: {
                    start: document.textDocument.positionAt(
                        prefix.indexOf('value object OrderId { raw: string }') + 'value object OrderId { raw: string }'.length
                    ),
                    end: document.textDocument.positionAt(prefix.length)
                },
                newText: '\n    enum'
            });
    });

    test('offers reads-from as a method sibling with a structural line break', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { behavior "Check the request." ';
        const source = `${prefix}} }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-sibling-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const item = completion?.items.find(candidate => candidate.label === 'reads from');
        expect(item).toBeDefined();
        expect(item?.data?.thinaiSiblingCompletion).toBe(true);
        expect(item?.insertTextMode).toBe(InsertTextMode.asIs);
        expect(item?.textEdit?.newText).toBe('\n      reads from');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('reads');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('from');
    });

    test('offers reads from as one item in an empty method body', async () => {
        const prefix = `bounded context Ordering in bounded context Ordering {
            application service App {
                method run() {
                    `;
        const source = `${prefix}\n                }\n            }\n        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-empty-method-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const item = completion?.items.find(candidate => candidate.label === 'reads from');
        expect(item).toBeDefined();
        expect(item?.kind).toBe(CompletionItemKind.Keyword);
        expect(item?.textEdit?.newText).toContain('reads from');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('reads');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('from');
    });

    test('ignores braces inside behavior text when computing sibling indentation depth', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { invokes validate when "Keep {" ';
        const source = `${prefix}} } }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/brace-in-specification-sibling-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const invocation = completion?.items.find(item => item.label === 'invokes');
        expect(invocation?.data).toMatchObject({ thinaiIndentationDepth: 3 });
        expect(invocation?.textEdit).toMatchObject({ newText: '\n      invokes' });
    });

    test('expands an empty value-object block when completing its first member', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering {\n  value object OrderId {';
        const source = `${prefix}}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/empty-value-object-member-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        for (const label of ['constructor', 'method']) {
            const item = completion?.items.find(candidate => candidate.label === label);
            expect(item?.detail).toBe('Language keyword');
            expect(item?.data?.thinaiSiblingCompletion).toBe(true);
            expect(item?.insertTextMode).toBe(InsertTextMode.asIs);
            expect(item?.data).toMatchObject({ thinaiIndentationDepth: 2 });
            expect(item?.textEdit).toMatchObject({
                range: {
                    start: document.textDocument.positionAt(prefix.length),
                    end: document.textDocument.positionAt(source.length - 1)
                },
                newText: `\n    ${label}\n  `
            });
            expect(applyConfiguredIndentationToCompletions([item!], 4, false)[0]?.textEdit?.newText)
                .toBe(`\n\t\t${label}\n\t`);
        }
    });

    test('preserves comments and ignores braces inside them when completing the first block member', async () => {
        const prefix = `bounded context Ordering
in bounded context Ordering {
  module Api { /* { */ `;
        const source = `${prefix}}
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/comment-brace-empty-block-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const item = completion?.items.find(candidate => candidate.label === 'value object');

        expect(item?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.indexOf('{', prefix.indexOf('module Api')) + 1),
                end: document.textDocument.positionAt(source.indexOf('}', prefix.length))
            },
            newText: '\n    /* { */\n    value object\n  '
        });
        expect(applyConfiguredIndentationToCompletions([item!], 4, false)[0]?.textEdit?.newText)
            .toBe('\n\t\t/* { */\n\t\tvalue object\n\t');
    });

    test('keeps a resolved user type named String complete for same-line sibling completion', async () => {
        const source = `bounded context Types in bounded context Types {
            value object String { raw: string }
            value object Holder {
                content: String${' '}
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/string-named-type-completion.tni'), source
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const offset = source.indexOf('content: String') + 'content: String '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const method = completion?.items.find(item => item.label === 'method');

        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.textEdit).toMatchObject({ newText: '\n                method' });
    });

    test('corrects indentation when completing a member on an already-indented next line', async () => {
        const prefix = `bounded context Ordering
in bounded context Ordering {
  value object Currency {
    code: string
        con`;
        const source = `${prefix}
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/incorrectly-indented-value-object-member.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const constructor = completion?.items.find(item => item.label === 'constructor');
        expect(constructor?.detail).toBe('Language keyword');
        expect(constructor?.data?.thinaiSiblingCompletion).toBe(true);
        expect(constructor?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.lastIndexOf('\n') + 1),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '    constructor'
        });
    });

    test('aligns blank-line member completion with the preceding field in a shared-kernel value object', async () => {
        const prefix = `shared kernel CommonTypes {
  value object Currency {
    code: string
        `;
        const source = `${prefix}
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-value-object-member-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const method = completion?.items.find(item => item.label === 'method');
        expect(method?.detail).toBe('Language keyword');
        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.preselect).toBe(true);
        expect(method?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.lastIndexOf('\n') + 1),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '    method'
        });
    });

    test('replaces a partially typed same-line value-object member when moving it to a sibling line', async () => {
        const prefix = 'shared kernel CommonTypes\n  value object Currency {\n    code: string met';
        const source = `${prefix}\n  }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/partial-same-line-value-object-member.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const method = completion?.items.find(item => item.label === 'method');
        expect(method?.detail).toBe('Language keyword');
        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.preselect).toBe(true);
        expect(method?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.indexOf('code: string') + 'code: string'.length),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '\n    method'
        });
    });

    test('replaces partial member text on an over-indented next line in a shared kernel', async () => {
        const prefix = `shared kernel CommonTypes {
  value object Currency {
    code: string
        met`;
        const source = `${prefix}
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/partial-next-line-shared-kernel-member.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const method = completion?.items.find(item => item.label === 'method');
        expect(method?.detail).toBe('Language keyword');
        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.lastIndexOf('\n') + 1),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '    method'
        });
    });

    test('offers top-level keywords in a gap before a later declaration', async () => {
        const marker = '__completion_position__';
        const source = `import "./strategic.tni"

bounded context Ordering realizes OrderManagement, SharedCapabilities

${marker}
bounded context Shipping realizes Fulfillment

bounded context Billing realizes Payments`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-catalog-gap-completion.tni'), text
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('bounded context');
        expect(labels).toContain('subdomain');
        expect(labels).toContain('shared kernel');
        expect(labels).toContain('context map');
    });

    test('completes module members after exposure declarations without throwing', async () => {
        const marker = '__completion_position__';
        const source = `shared kernel Common {
            value object CorrelationId { raw: string }
            value object TenantId { constructor(raw: string) {} raw: string }
            module Identity {
                exposes CorrelationId, TenantId
                ${marker}
            }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-exposure-completion.tni'), text
        );
        documents.push(document);
        expect(document.parseResult.parserErrors).toEqual([]);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('value object');
        expect(labels).toContain('domain service');
        expect(labels).not.toContain('aggregate');
        expect(labels).not.toContain('application service');
    });

    test('restricts module keyword suggestions inside shared kernels', async () => {
        const marker = '__completion_position__';
        const source = `shared kernel Common {
            value object CorrelationId { raw: string }
            module Types { ${marker} }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-module-completion.tni'), text
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining([
            'exposes', 'domain service', 'module', 'value object', 'enum'
        ]));
        for (const unsupported of [
            'aggregate', 'application service', 'data object', 'entity', 'repository',
            'string', 'number', 'boolean', 'date', 'time', 'instant', 'List', 'Set', 'Map'
        ]) {
            expect(labels).not.toContain(unsupported);
        }
    });

    test('does not treat inherited object properties as compound keywords', () => {
        const provider = new ThinaiCompletionProvider(services.Thinai) as unknown as {
            withCompoundKeywordCompletions: (
                completion: CompletionList,
                continuations: CompletionItem[]
            ) => CompletionList | undefined
        };
        const completion: CompletionList = {
            isIncomplete: false,
            items: [{ label: 'constructor', kind: CompletionItemKind.Keyword }]
        };
        expect(provider.withCompoundKeywordCompletions(completion, [])?.items).toEqual(completion.items);
    });

    test('offers sibling elements after a closing brace on the same line or after a newline', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'module in bounded context, same line',
                prefix: 'bounded context Ordering\nin bounded context Ordering {\n    module Api {}',
                suffix: '\n}',
                expected: ['aggregate', 'application service']
            },
            {
                name: 'module in bounded context, next line',
                prefix: 'bounded context Ordering\nin bounded context Ordering {\n    module Api {}\n    ',
                suffix: '\n}',
                expected: ['aggregate', 'application service']
            },
            {
                name: 'module in shared kernel',
                prefix: 'shared kernel Common {\n    module Api {}\n    ',
                suffix: '\n}',
                expected: ['value object', 'domain service']
            },
            {
                name: 'value object in aggregate',
                prefix: 'bounded context Ordering\nin bounded context Ordering { aggregate A { value object V { raw: string }\n    ',
                suffix: ' } }',
                expected: ['entity', 'enum']
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const source = `${completionCase.prefix}${marker}${completionCase.suffix}`;
            const offset = source.indexOf(marker);
            const text = source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/closing-brace-completion-${index}.tni`), text
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const expected of completionCase.expected) {
                expect(labels, completionCase.name).toContain(expected);
            }
        }
    });

    test('offers primitive types while completing incomplete type positions', async () => {
        const marker = '__completion_position__';
        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toEqual(
            expect.arrayContaining([':', '<', ','])
        );
        const cases = [
            {
                name: 'field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amount: ${marker} } } }`,
                expectedPrefix: ''
            },
            {
                name: 'field type without a separating space',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amount:${marker} } } }`,
                expectedPrefix: ''
            },
            {
                name: 'partial field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amount: str${marker} } } }`,
                expectedPrefix: 'str'
            },
            {
                name: 'partial time field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { opensAt: ti${marker} } } }`,
                expectedPrefix: 'ti',
                expectedPrimitive: 'time'
            },
            {
                name: 'partial instant field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { createdAt: ins${marker} } } }`,
                expectedPrefix: 'ins',
                expectedPrimitive: 'instant'
            },
            {
                name: 'method parameter type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run(amount: ${marker}) } }`,
                expectedPrefix: ''
            },
            {
                name: 'constructor parameter type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { constructor(amount: ${marker}) {} } } }`,
                expectedPrefix: ''
            },
            {
                name: 'method parameter collection element type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run(amounts: List<${marker}>) } }`,
                expectedPrefix: ''
            },
            {
                name: 'method return type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run() returns ${marker} } }`,
                expectedPrefix: ''
            },
            {
                name: 'method return collection element type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run() returns List<${marker}> } }`,
                expectedPrefix: ''
            },
            {
                name: 'collection element type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: List<${marker}> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'nested collection element type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: List<Set<${marker}>> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'map key type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: Map<${marker}, string> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'map value type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: Map<string, ${marker}> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'type inside a nested shared-kernel module',
                before: `shared kernel Common { module Outer { module Inner { value object Identifier { raw: ${marker} } } } }`,
                expectedPrefix: ''
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.before.indexOf(marker);
            const text = completionCase.before.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/primitive-type-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const expectedPrimitive = completionCase.expectedPrimitive ?? 'string';
            const primitive = completion?.items.find(item => item.label === expectedPrimitive);
            expect(primitive, completionCase.name).toMatchObject({
                kind: CompletionItemKind.Keyword,
                textEdit: {
                    range: {
                        start: document.textDocument.positionAt(offset - completionCase.expectedPrefix.length),
                        end: document.textDocument.positionAt(offset)
                    },
                    newText: expectedPrimitive
                }
            });
            expect(completion?.items.map(item => item.label), completionCase.name).toEqual(
                expect.arrayContaining(completionCase.expectedPrefix
                    ? [expectedPrimitive]
                    : ['string', 'number', 'boolean', 'date', 'time', 'instant'])
            );
        }
    });

    test('does not log errors while completing an import alias', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-completion-target.tni'), 'bounded context Target'
        );
        const source = 'import { Target as  } from "./alias-completion-target.tni"';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-completion-source.tni'), source
        );
        documents.push(target, document);
        await services.shared.workspace.DocumentBuilder.build([target, document], { validation: false });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.indexOf('as ') + 'as '.length)
            });
            expect(completion?.items).toEqual([]);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('does not leak sibling or guard keywords after a trailing comma', async () => {
        const source = `bounded context C
in bounded context C {
  aggregate A {
    root entity E {
      method m() {
        emits E1,
      }
      identifier id: Id
    }
    value object Id { raw: string }
    event E1
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/trailing-comma-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('emits E1,') + 'emits E1,'.length)
        });
        expect(completion?.items.filter(item => item.kind === CompletionItemKind.Keyword)).toEqual([]);
    });

    test('completes partner integration patterns and reads-from guards', async () => {
        const partnerSource = `bounded context Alpha
in bounded context Alpha { aggregate X { root entity X { identifier id: XId } value object XId { raw: string } } }
bounded context Beta
context map M {
  partner Alpha {  } <-> partner Beta
}`;
        const partner = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/partner-integration-patterns.tni'), partnerSource
        );
        documents.push(partner);
        await services.shared.workspace.DocumentBuilder.build([partner], { validation: false });
        const partnerCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(partner, {
            textDocument: { uri: partner.uri.toString() },
            position: partner.textDocument.positionAt(partnerSource.indexOf('partner Alpha { ') + 'partner Alpha { '.length)
        });
        expect(partnerCompletion?.items.map(item => item.label)).toContain('integrationPatterns');

        const readsSource = `bounded context C
in bounded context C {
  repository R { manages A.E }
  aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
  application service S {
    method m() {
      reads from R
    }
  }
}`;
        const reads = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-when.tni'), readsSource
        );
        documents.push(reads);
        await services.shared.workspace.DocumentBuilder.build([reads], { validation: false });
        const readsCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(reads, {
            textDocument: { uri: reads.uri.toString() },
            position: reads.textDocument.positionAt(readsSource.indexOf('reads from R') + 'reads from R'.length)
        });
        expect(readsCompletion?.items.map(item => item.label)).toContain('when');
    });

    test('does not offer sibling statements while a named type is incomplete', async () => {
        const source = `bounded context C
in bounded context C {
  aggregate A {
    root entity E {
      method run() returns Ord
      identifier id: Id
    }
    value object Id { raw: string }
    value object OrderId { raw: string }
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/incomplete-named-type.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('returns Ord') + 'returns Ord'.length)
        });
        const keywordLabels = completion?.items
            .filter(item => item.kind === CompletionItemKind.Keyword)
            .map(item => item.label);
        expect(keywordLabels).not.toContain('method');
        expect(keywordLabels).not.toContain('constructor');
    });

    test('offers initial once for the field being edited', async () => {
        const source = `bounded context C
in bounded context C {
  aggregate A {
    root entity E {
      method m()
      identifier id: Id
      other: Status
      status: Status ini
    }
    value object Id { raw: string }
    enum Status { Open, Closed }
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/initial-completion-once.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const initialCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('status: Status ini') + 'status: Status ini'.length)
        });
        expect(initialCompletion?.items.filter(item => item.label === 'initial')).toHaveLength(1);
    });

    test('completes a transition after a field name containing "transition"', async () => {
        const source = `bounded context C
in bounded context C {
  aggregate A {
    root entity E {
      method m() {
        transition a from Open to Closed, stateTransition f
      }
      identifier id: Id
      a: Status
      stateTransition: Status
    }
    value object Id { raw: string }
    enum Status { Open, Closed }
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/transition-name-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const transitionCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('stateTransition f') + 'stateTransition f'.length)
        });
        expect(transitionCompletion?.items.map(item => item.label)).toContain('from');
    });

    test('keeps completion inside a shared-kernel module at end of input', async () => {
        const source = 'shared kernel K {\n  module M {\n    ';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-eof-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.length)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('value object');
        expect(labels).toContain('domain service');
        expect(labels).not.toContain('bounded context');
    });

    test('does not complete private aggregate internals in journey prose', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
  aggregate Order {
    root entity Order {
      method place()
      identifier id: OrderId
      secret: string
    }
    value object OrderId { raw: string }
  }
  application service Commands { method run() }
}
actor Customer
journey PlaceOrder {
  by Customer {
    invoke Ordering.Commands.run
      when "Private [[Ordering.Order.Order.se"
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-private-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const marker = '[[Ordering.Order.Order.se';
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf(marker) + marker.length)
        });
        expect(completion?.items.map(item => item.label)).not.toContain('secret');
    });

    test('completes structural segments of cross-context specification paths', async () => {
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-spec-catalog.tni'),
            `bounded context Catalog
in bounded context Catalog {
    module PublicApi {
        exposes ProductQueries, ProductInfo
        data object ProductInfo {
            address: ProductAddress
        }
        data object ProductAddress {
            city: string
        }
        query service ProductQueries {
            method find(sku: string) returns ProductInfo
        }
    }
}`
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-spec-contexts.tni'),
            'bounded context Ordering'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-spec-map.tni'),
            `import "./cross-context-spec-contexts.tni"
import "./cross-context-spec-catalog.tni"
context map Commerce {
    customer Ordering -> supplier Catalog
}`
        );
        const consumerTemplate = `import "./cross-context-spec-contexts.tni"
import "./cross-context-spec-catalog.tni"
import { Commerce } from "./cross-context-spec-map.tni"
in bounded context Ordering {
    application service App {
        method check(sku: string) {
            reads from Catalog.PublicApi.ProductQueries.find
            behavior "Use __CURSOR__"
        }
    }
}`;

        const completionAt = async (marker: string, index: number) => {
            const consumerText = consumerTemplate.replace('__CURSOR__', marker);
            const consumer = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/cross-context-spec-consumer-${index}.tni`), consumerText
            );
            documents.push(consumer);
            await services.shared.workspace.DocumentBuilder.build([catalog, contexts, contextMap, consumer], { validation: false });
            const offset = consumerText.indexOf(marker) + marker.length;
            return services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
                textDocument: { uri: consumer.uri.toString() },
                position: consumer.textDocument.positionAt(offset)
            });
        };

        const root = await completionAt('[[', 0);
        expect(root?.items.map(item => item.label)).toContain('Catalog');

        const catalogSegment = await completionAt('[[Catalog.', 1);
        expect(catalogSegment?.items.map(item => item.label)).toContain('PublicApi');

        const moduleSegment = await completionAt('[[Catalog.PublicApi.', 2);
        expect(moduleSegment?.items.map(item => item.label)).toContain('ProductInfo');
    });

    test('completes prior command results but not the current command result in journeys', async () => {
        const marker = '__CURSOR__';
        const makeSource = (path: string) => `bounded context Ordering
in bounded context Ordering {
    data object PlaceOrderResult {
        orderId: string
    }
    data object PayResult {
        paid: boolean
    }
    application service OrderApplication {
        method placeOrder() returns PlaceOrderResult
        method pay() returns PayResult
    }
}
actor Customer
journey PlaceOrder {
    by Customer {
        invoke Ordering.OrderApplication.placeOrder
        invoke Ordering.OrderApplication.pay
            when "Result [[${path}${marker}]]"
    }
}`;

        const priorText = makeSource('Ordering.OrderApplication.placeOrder.result.');
        const prior = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-prior-result-completion.tni'), priorText.replace(marker, '')
        );
        documents.push(prior);
        await services.shared.workspace.DocumentBuilder.build([prior], { validation: false });
        const priorOffset = priorText.indexOf(marker);
        const priorCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(prior, {
            textDocument: { uri: prior.uri.toString() },
            position: prior.textDocument.positionAt(priorOffset)
        });
        expect(priorCompletion?.items.map(item => item.label)).toContain('orderId');

        const currentText = makeSource('Ordering.OrderApplication.pay.result.');
        const current = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-current-result-completion.tni'), currentText.replace(marker, '')
        );
        documents.push(current);
        await services.shared.workspace.DocumentBuilder.build([current], { validation: false });
        const currentOffset = currentText.indexOf(marker);
        const currentCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(current, {
            textDocument: { uri: current.uri.toString() },
            position: current.textDocument.positionAt(currentOffset)
        });
        expect(currentCompletion?.items.map(item => item.label)).not.toContain('paid');
    });

    test('completes from after a multiline import component list', async () => {
        const marker = '__CURSOR__';
        const source = `import {
    First,
    Second
} ${marker}
bounded context Alpha
`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiline-import-from-completion.tni'), source.replace(marker, '')
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const offset = source.indexOf(marker);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.map(item => item.label)).toContain('from');
    });

    test('does not offer unrelated header continuations inside a method body', async () => {
        const source = `bounded context Alpha
in bounded context Alpha {
  aggregate A {
    root entity E {
      method m() {
        r
      }
      identifier id: Id
    }
    value object Id { raw: string }
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unrelated-header-continuation.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('        r') + '        r'.length)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('realizes');
        expect(labels).toContain('reads from');
    });

    test('offers aggregate path containers in journey contract completion', async () => {
        const marker = '__CURSOR__';
        const source = `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order { identifier id: OrderId }
        value object OrderId { raw: string }
    }
    data object Input { orderId: OrderId }
    application service App { method place(input: Input) }
}
actor Customer
journey PlaceOrder {
    by Customer {
        invoke Ordering.App.place
            with "Use [[Ordering.${marker}]]"
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-aggregate-path-completion.tni'), source.replace(marker, '')
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf(marker))
        });
        expect(completion?.items.map(item => item.label)).toContain('Order');
    });

    test('describes real parameter names in completion details', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    application service App {
        method use(input: string) {
            behavior "Use [[inp]]."
        }
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/real-parameter-detail.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('[[inp') + '[[inp'.length)
        });
        const item = completion?.items.find(candidate => candidate.label === 'input');
        expect(item?.detail).toBe('Parameter input: string');
    });

    test('offers map value shape fields in specification completion', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    value object Key { keyField: string }
    value object Value { valueField: string }
    application service App {
        method use(input: Map<Key, Value>) {
            behavior "Use [[input.]]."
        }
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/map-key-shape-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf('[[input.]]') + '[[input.'.length)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('keyField');
        expect(labels).toContain('valueField');
    });

    test('completes aliased prior command results in journeys', async () => {
        const app = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/aliased-prior-command-app.tni'),
            `bounded context Ordering
in bounded context Ordering {
    data object Result {
        status: string
    }
    application service App {
        method first() returns Result
        method second()
    }
}`
        );
        const source = `import { Ordering as Orders } from "./aliased-prior-command-app.tni"
actor Customer
journey J {
    by Customer {
        invoke Orders.App.first
        invoke Orders.App.second
            when "Previous [[Orders.App.first.result.status]]"
    }
}`;
        const journey = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/aliased-prior-command-journey.tni'), source
        );
        documents.push(app, journey);
        await services.shared.workspace.DocumentBuilder.build([app, journey], { validation: true });
        expect(journey.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toEqual([]);

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(journey, {
            textDocument: { uri: journey.uri.toString() },
            position: journey.textDocument.positionAt(
                source.indexOf('[[Orders.App.first.result.status]]') + '[[Orders.App.first.result.'.length
            )
        });
        expect(completion?.items.map(item => item.label)).toContain('status');
    });

    test('completes nested event payload fields from an event parameter', async () => {
        const marker = '__CURSOR__';
        const source = `bounded context Api
bounded context Consumer
in bounded context Api {
    module Contracts {
        exposes E, Address
        value object Address { city: string }
        integration event E { address: Address }
    }
}
in bounded context Consumer {
    application service App {
        method handle(source: Api.Contracts.E) {
            behavior "Use [[source.address.${marker}]]."
        }
    }
}
context map M {
    customer Consumer -> supplier Api
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/nested-event-payload-completion.tni'), source.replace(marker, '')
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(source.indexOf(marker))
        });
        expect(completion?.items.map(item => item.label)).toContain('city');
    });

    test('recognizes the query-repository read position before linking', () => {
        const marker = '__CURSOR__';
        const source = `bounded context Ordering
in bounded context Ordering {
    read model OrderSummary { status: string }
    query repository SummaryQuery {
        serves OrderSummary
        ${marker}
    }
}`;
        const offset = source.indexOf(marker);
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unbuilt-query-repository-read.tni'), source.replace(marker, '')
        );
        documents.push(document);

        expect(isQueryRepositoryReadCompletionPosition(document, offset)).toBe(true);
    });

    test('falls back to the line range for whitespace-only selection positions', async () => {
        const source = 'bounded context Ordering\n   \nbounded context Shipping';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/whitespace-selection-range.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const selection = createThinaiSelectionRange(document, { line: 1, character: 1 });
        expect(selection?.range).toEqual({
            start: { line: 1, character: 0 },
            end: { line: 1, character: 3 }
        });
    });

    test('falls back to the line range for CR-only whitespace selection positions', async () => {
        const source = 'bounded context Ordering\r   \rbounded context Shipping';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cr-whitespace-selection-range.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const selection = createThinaiSelectionRange(document, { line: 1, character: 1 });
        expect(selection?.range).toEqual({
            start: { line: 1, character: 0 },
            end: { line: 1, character: 3 }
        });
    });
});
