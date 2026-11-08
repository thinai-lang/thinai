import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import { type CompletionContext, type CompletionValueItem } from 'langium/lsp';
import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionList,
    type Position
} from 'vscode-languageserver';
import type { AstNodeDescription } from 'langium';
import type { ContextMap } from './generated/ast.js';
import { isBoundedContext } from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import { ThinaiScopeProvider } from './thinai-scope-provider.js';
import { getSiblingCompletionKeywords } from './thinai-layout.js';
import { formatQualifiedName } from './thinai-scope-utils.js';
import { normalizeIdentifierText, THINAI_QUALIFIED_IDENTIFIER_SOURCE, unquoteQualifiedName } from './thinai-identifiers.js';
import {
    areRelationshipPairDefinitionsCompatible,
    createRelationshipPairSemantics,
    getRelationshipPairSemantics,
    type ContextRelationshipPairKind
} from './thinai-context-map-utils.js';
import { getLineStartOffset } from './thinai-text-utils.js';

const contextEndpointPattern = THINAI_QUALIFIED_IDENTIFIER_SOURCE;
const integrationPatternsClause = String.raw`\{\s*integrationPatterns\s*:\s*\[[^\]]*\]\s*\}`;
const relationshipContinuationPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [new RegExp(String.raw`^\s*customer\s+${contextEndpointPattern}(?:\s*${integrationPatternsClause})?\s+$`, 'u'), '-> supplier'],
    [new RegExp(String.raw`^\s*partner\s+${contextEndpointPattern}(?:\s*${integrationPatternsClause})?\s+$`, 'u'), '<-> partner'],
    [new RegExp(String.raw`^\s*separateWays\s+${contextEndpointPattern}\s+$`, 'u'), '-x-']
];
const rightContextPatterns: ReadonlyArray<{
    pattern: RegExp;
    kind: Exclude<ContextRelationshipPairKind, 'sharedKernel'>;
}> = [
    {
        pattern: new RegExp(String.raw`^\s*customer\s+(${contextEndpointPattern})(?:\s*${integrationPatternsClause})?\s*->\s*supplier\s*(.*)$`, 'iu'),
        kind: 'customerSupplier'
    },
    {
        pattern: new RegExp(String.raw`^\s*partner\s+(${contextEndpointPattern})(?:\s*${integrationPatternsClause})?\s*<->\s*partner\s*(.*)$`, 'iu'),
        kind: 'partnership'
    },
    {
        pattern: new RegExp(String.raw`^\s*separateWays\s+(${contextEndpointPattern})\s+-x-\s*(.*)$`, 'iu'),
        kind: 'separateWays'
    }
];

interface ContextMapCompletionCallbacks {
    isCompleteSameLineSibling(node: AstNode, document: LangiumDocument, position: Position): boolean;
    getCompletionDetail(description: AstNodeDescription): string;
    getCompletionContext(document: LangiumDocument, position: Position): CompletionContext | undefined;
    fillCompletionItem(context: CompletionContext, item: CompletionValueItem): CompletionItem | undefined;
}

/** Context-map relationship completion kept separate from general grammar completion. */
export class ThinaiContextMapCompletion {
    constructor(
        private readonly services: ThinaiServices,
        private readonly callbacks: ContextMapCompletionCallbacks
    ) {}

    filterKeywords(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined
    ): CompletionList | undefined {
        if (!completion) {
            return completion;
        }
        const root = document.parseResult.value;
        if (!root) {
            return completion;
        }
        const offset = document.textDocument.offsetAt(position);
        const inContextMap = AstUtils.streamAst(root).some(node => {
            if (node.$type !== 'ContextMap') {
                return false;
            }
            const cstNode = node.$cstNode;
            return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
        });
        const hasBoundedContextCandidates = completion.items.some(item =>
            item.detail?.startsWith('BoundedContext ')
        );
        const relationshipLineState = this.getRelationshipLineState(document, position);
        const shouldFilterKeywords = relationshipLineState === 'incomplete' ||
            hasBoundedContextCandidates && relationshipLineState !== 'complete';
        if (!inContextMap || !shouldFilterKeywords) {
            return completion;
        }
        return {
            ...completion,
            items: completion.items.filter(item =>
                item.kind !== CompletionItemKind.Keyword ||
                !getSiblingCompletionKeywords('ContextMap').includes(String(item.label))
            )
        };
    }

    getRelationshipContinuations(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const contextMap = AstUtils.streamAst(root)
            .filter(node => node.$type === 'ContextMap')
            .find(node => {
                const cstNode = node.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset <= cstNode.end;
            });
        if (!contextMap) {
            return [];
        }

        const lineStart = getLineStartOffset(document, offset);
        const prefixes = AstUtils.streamAst(contextMap)
            .filter(node => node.$type === 'CustomerSupplierRelationship' ||
                node.$type === 'PartnershipRelationship' || node.$type === 'SeparateWaysRelationship')
            .map(node => node.$cstNode)
            .filter((cstNode): cstNode is NonNullable<typeof cstNode> => cstNode !== undefined && cstNode.offset <= offset)
            .toArray()
            .sort((left, right) => right.offset - left.offset)
            .map(cstNode => text.slice(cstNode.offset, offset));
        prefixes.push(text.slice(lineStart, offset));
        const continuation = prefixes.flatMap(prefix =>
            relationshipContinuationPatterns.filter(([pattern]) => pattern.test(prefix)).map(([, label]) => label)
        )[0];
        if (!continuation) {
            return [];
        }
        return [{
            label: continuation,
            kind: CompletionItemKind.Operator,
            detail: 'Context-map relationship continuation',
            sortText: '0',
            textEdit: {
                range: { start: position, end: position },
                newText: `${continuation} `
            }
        }];
    }

    getRightContextCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const contextMap = AstUtils.streamAst(root)
            .filter(candidate => candidate.$type === 'ContextMap')
            .find(candidate => {
                const cstNode = candidate.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
            }) as ContextMap | undefined;
        if (!contextMap) {
            return [];
        }
        const prefixes = AstUtils.streamAst(contextMap)
            .filter(candidate => candidate.$type === 'CustomerSupplierRelationship' ||
                candidate.$type === 'PartnershipRelationship' || candidate.$type === 'SeparateWaysRelationship')
            .map(candidate => candidate.$cstNode)
            .filter((cstNode): cstNode is NonNullable<typeof cstNode> => cstNode !== undefined && cstNode.offset <= offset)
            .toArray()
            .sort((left, right) => right.offset - left.offset)
            .map(cstNode => text.slice(cstNode.offset, offset));
        prefixes.push(text.slice(lineStart, offset));
        const match = prefixes.flatMap(prefix =>
            rightContextPatterns.map(({ pattern, kind }) => {
                const result = pattern.exec(prefix);
                return result ? { result, kind } : undefined;
            }).filter((candidate): candidate is { result: RegExpExecArray; kind: Exclude<ContextRelationshipPairKind, 'sharedKernel'> } =>
                candidate !== undefined
            )
        )[0];
        if (!match) {
            return [];
        }

        const leftContextName = unquoteQualifiedName(match.result[1] ?? '');
        const typedRaw = match.result[2] ?? '';
        const typedPrefix = normalizeIdentifierText(typedRaw.trim());
        const prefixStart = offset - typedRaw.length;
        const needsLeadingSpace = prefixStart > 0 && !/\s/.test(text[prefixStart - 1]!);
        const scopeProvider = this.services.references.ScopeProvider as ThinaiScopeProvider;
        const completionContext = this.callbacks.getCompletionContext(document, position);
        const contextCandidates = scopeProvider.getContextMapBoundedContextCandidates(contextMap);
        const leftContext = contextCandidates.find(description => description.name === leftContextName)?.node;
        const existingPairs = contextMap.relationships.flatMap(relationship =>
            getRelationshipPairSemantics(relationship)
        );
        return contextCandidates
            .filter(description => !leftContext || description.node !== leftContext)
            .filter(description => this.matchesCompletionPrefix(description.name, typedPrefix))
            .filter(description => {
                if (!isBoundedContext(leftContext) || !isBoundedContext(description.node)) {
                    return true;
                }
                const prospective = createRelationshipPairSemantics(match.kind, leftContext, description.node);
                if (!prospective) {
                    return false;
                }
                return !existingPairs.some(pair => pair.key === prospective.key &&
                    (pair.identity === prospective.identity ||
                        !areRelationshipPairDefinitionsCompatible(pair, prospective)));
            })
            .map(description => {
                const insertText = `${needsLeadingSpace ? ' ' : ''}${formatQualifiedName(description.name)}`;
                const item: CompletionValueItem = {
                    nodeDescription: description,
                    kind: this.services.shared.lsp.NodeKindProvider.getCompletionItemKind(description),
                    detail: this.callbacks.getCompletionDetail(description),
                    sortText: '0',
                    insertText
                };
                const langiumItem = completionContext
                    ? this.callbacks.fillCompletionItem(completionContext, item)
                    : undefined;
                return langiumItem ?? {
                    ...item,
                    label: description.name,
                    textEdit: {
                        range: { start: document.textDocument.positionAt(prefixStart), end: position },
                        newText: insertText
                    }
                };
            });
    }

    private matchesCompletionPrefix(name: string, typedPrefix: string): boolean {
        if (typedPrefix.length === 0) {
            return true;
        }
        return name.toLowerCase().startsWith(typedPrefix.toLowerCase()) ||
            this.services.shared.lsp.FuzzyMatcher.match(typedPrefix, name);
    }

    private getRelationshipLineState(document: LangiumDocument, position: Position): 'incomplete' | 'complete' | undefined {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const relationshipPrefix = text.slice(lineStart, offset).trim();
        if (!/^(?:customer|partner|separateWays)\b/i.test(relationshipPrefix)) {
            return undefined;
        }
        const model = document.parseResult.value;
        if (!model) {
            return 'incomplete';
        }
        const relationship = AstUtils.streamAst(model)
            .filter(node => node.$type === 'CustomerSupplierRelationship' ||
                node.$type === 'PartnershipRelationship' || node.$type === 'SeparateWaysRelationship')
            .filter(node => node.$cstNode?.range.start.line === position.line &&
                node.$cstNode.offset <= offset && node.$cstNode.end <= offset)
            .toArray()
            .sort((left, right) => right.$cstNode!.end - left.$cstNode!.end)[0];
        if (!relationship?.$cstNode || !this.callbacks.isCompleteSameLineSibling(relationship, document, position)) {
            return 'incomplete';
        }
        return /^[\t ]+$/.test(text.slice(relationship.$cstNode.end, offset)) ? 'complete' : 'incomplete';
    }
}
