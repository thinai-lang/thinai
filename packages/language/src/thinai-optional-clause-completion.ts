import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import { CompletionItemKind, type CompletionItem, type Position } from 'vscode-languageserver';
import type { ThinaiServices } from './thinai-module.js';
import {
    isApplicationService,
    isDomainEvent,
    isEventEmission,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isTransition
} from './generated/ast.js';
import { canDeclareTransition, getEventEmissionMode } from './thinai-operation-utils.js';
import { ThinaiScopeProvider } from './thinai-scope-provider.js';

/** Completes optional guards and journey input clauses at completed statements. */
export class ThinaiOptionalClauseCompletion {
    constructor(private readonly services: ThinaiServices) {}

    getCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const model = document.parseResult.value;
        if (!model) {
            return [];
        }

        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        let best: { end: number; prefix: string; keywords: string[]; needsLeadingSpace: boolean } | undefined;
        const hasCompletedReference = (reference?: {
            ref?: AstNode;
            $refText?: string;
            $refNode?: { end: number };
        }) => reference?.ref !== undefined ||
            typeof reference?.$refText === 'string' && reference.$refText.length > 0 &&
            reference.$refNode !== undefined && reference.$refNode.end < offset;
        const getEnclosingMethod = (node: AstNode) => AstUtils.getContainerOfType(node, isMethod);
        const isJourneyCommand = (targets: Array<{ ref?: AstNode }>): boolean => {
            const target = targets.at(-1)?.ref;
            return isMethod(target) && isApplicationService(target.$container) && !target.parameters.some(parameter =>
                isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
            );
        };
        const scopeProvider = this.services.references.ScopeProvider as ThinaiScopeProvider;
        for (const node of AstUtils.streamAst(model)) {
            const nodeSource = node.$cstNode?.text ?? '';
            const whenAlreadyTyped = /\bwhen\b/iu.test(nodeSource);
            let keywords: string[] = [];
            if (isJourneyStep(node) && isJourneyCommand(node.targets) && !whenAlreadyTyped) {
                keywords = [
                    ...(!node.arguments ? ['with'] : []),
                    ...(!node.guard ? ['when'] : [])
                ];
            } else if (isTransition(node)) {
                const method = getEnclosingMethod(node);
                if (method && canDeclareTransition(method) && node.changes.length > 0 && node.changes.every(change =>
                    hasCompletedReference(change.field) && hasCompletedReference(change.from) && hasCompletedReference(change.to)
                ) && !node.guard && !whenAlreadyTyped && !nodeSource.trimEnd().endsWith(',')) {
                    keywords = ['when'];
                }
            } else if (isEventEmission(node)) {
                const method = getEnclosingMethod(node);
                const emissionMode = method ? getEventEmissionMode(method) : undefined;
                const hasAllowedEvents = emissionMode !== undefined && node.events.length > 0 && node.events.every(event => {
                    const target = event.target?.ref;
                    return target
                        ? emissionMode === 'domain' ? isDomainEvent(target) : isIntegrationEvent(target)
                        : hasCompletedReference(event.target);
                });
                if (hasAllowedEvents && !node.guard && !whenAlreadyTyped) {
                    keywords = ['when'];
                }
            } else if (isMethodInvocation(node)) {
                const target = node.targets.at(-1)?.ref;
                if (isMethod(target) && scopeProvider.canInvokeMethod(node, target) && !node.guard && !whenAlreadyTyped) {
                    keywords = ['when'];
                }
            }
            if (keywords.length === 0) {
                continue;
            }
            const cstNode = node.$cstNode;
            if (!cstNode) {
                continue;
            }
            const end = document.textDocument.offsetAt(cstNode.range.end);
            if (end > offset) {
                continue;
            }
            const gap = text.slice(end, offset);
            const match = /^(\s*)([\p{L}_]*)$/u.exec(gap);
            if (!match || !keywords.some(keyword =>
                match[2].length < keyword.length && keyword.startsWith(match[2].toLowerCase())
            )) {
                continue;
            }
            if (!best || end > best.end) {
                best = { end, prefix: match[2], keywords, needsLeadingSpace: match[1].length === 0 };
            }
        }
        if (!best) {
            return [];
        }

        const prefixStart = offset - best.prefix.length;
        return best.keywords
            .filter(keyword => keyword.startsWith(best!.prefix.toLowerCase()))
            .map(keyword => ({
                label: keyword,
                kind: CompletionItemKind.Keyword,
                detail: keyword === 'when' ? 'Guard clause' : 'Journey input clause',
                sortText: '1',
                textEdit: {
                    range: {
                        start: document.textDocument.positionAt(prefixStart),
                        end: position
                    },
                    newText: `${best!.needsLeadingSpace ? ' ' : ''}${keyword}`
                }
            }));
    }
}
