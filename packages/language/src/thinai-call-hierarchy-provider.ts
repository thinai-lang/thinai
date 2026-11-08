import {
    AstUtils,
    CstUtils,
    type AstNode,
    type LangiumDocument,
    type ReferenceDescription,
    type Stream,
    URI
} from 'langium';
import { AbstractCallHierarchyProvider } from 'langium/lsp';
import {
    SymbolKind,
    type CallHierarchyIncomingCall,
    type CallHierarchyIncomingCallsParams,
    type CallHierarchyItem,
    type CallHierarchyOutgoingCall,
    type CallHierarchyOutgoingCallsParams,
    type CallHierarchyPrepareParams
} from 'vscode-languageserver';
import type { ThinaiServices } from './thinai-module.js';
import {
    isJourney,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    type Journey,
    type JourneyStep,
    type Method
} from './generated/ast.js';
import { getExportedName } from './thinai-scope-utils.js';

/**
 * Call hierarchy for method invocations and journey steps, including
 * command and query steps. Event emissions and projectors are model
 * relationships rather than calls, so they are kept out of this view.
 */
export class ThinaiCallHierarchyProvider extends AbstractCallHierarchyProvider {
    constructor(private readonly thinaiServices: ThinaiServices) {
        super(thinaiServices);
    }

    override async prepareCallHierarchy(
        document: LangiumDocument,
        params: CallHierarchyPrepareParams
    ): Promise<CallHierarchyItem[] | undefined> {
        const result = await super.prepareCallHierarchy(document, params);
        if (result || document.textDocument.offsetAt(params.position) === 0) {
            return result;
        }
        // Cursor at the end of a name can land after the name token. Retry
        // inside the name before giving up.
        return super.prepareCallHierarchy(document, {
            ...params,
            position: document.textDocument.positionAt(document.textDocument.offsetAt(params.position) - 1)
        });
    }

    protected override getCallHierarchyItems(
        targetNode: AstNode,
        document: LangiumDocument
    ): CallHierarchyItem[] | undefined {
        const items = super.getCallHierarchyItems(targetNode, document);
        if (!items) {
            return undefined;
        }
        return items.map(item => ({
            ...item,
            kind: isJourney(targetNode) ? SymbolKind.Function : SymbolKind.Method,
            detail: 'name' in targetNode && typeof targetNode.name === 'string'
                ? getExportedName(targetNode as AstNode & { name: string })
                : item.detail
        }));
    }

    override async incomingCalls(
        params: CallHierarchyIncomingCallsParams
    ): Promise<CallHierarchyIncomingCall[] | undefined> {
        const target = await this.resolveItemTarget(params.item);
        if (!target) {
            return undefined;
        }
        return this.getIncomingCalls(
            target.node,
            this.references.findReferences(target.node, { includeDeclaration: false })
        );
    }

    override async outgoingCalls(
        params: CallHierarchyOutgoingCallsParams
    ): Promise<CallHierarchyOutgoingCall[] | undefined> {
        const target = await this.resolveItemTarget(params.item);
        if (!target) {
            return undefined;
        }
        return this.getOutgoingCalls(target.node);
    }

    protected async getIncomingCalls(
        _node: AstNode,
        references: Stream<ReferenceDescription>
    ): Promise<CallHierarchyIncomingCall[]> {
        const calls = new Map<string, CallHierarchyIncomingCall>();
        for (const reference of references) {
            const sourceDocument = await this.documents.getOrCreateDocument(reference.sourceUri);
            const sourceNode = this.thinaiServices.workspace.AstNodeLocator.getAstNode(
                sourceDocument.parseResult.value,
                reference.sourcePath
            );
            if (!sourceNode) {
                continue;
            }
            const invocation = isMethodInvocation(sourceNode)
                ? sourceNode
                : AstUtils.getContainerOfType(sourceNode, isMethodInvocation);
            const step = isJourneyStep(sourceNode)
                ? sourceNode
                : AstUtils.getContainerOfType(sourceNode, isJourneyStep);
            const owner = invocation
                ? AstUtils.getContainerOfType(invocation, isMethod)
                : step
                    ? AstUtils.getContainerOfType(step, isJourney)
                    : undefined;
            const range = invocation?.$cstNode?.range ?? step?.$cstNode?.range ?? reference.segment.range;
            if (!owner || !range) {
                continue;
            }
            const from = this.createItem(owner, sourceDocument);
            if (!from) {
                continue;
            }
            const key = `${from.uri}\u0000${from.selectionRange.start.line}:${from.selectionRange.start.character}`;
            const existing = calls.get(key);
            if (existing) {
                existing.fromRanges.push(range);
            } else {
                calls.set(key, { from, fromRanges: [range] });
            }
        }
        return [...calls.values()];
    }

    protected async getOutgoingCalls(node: AstNode): Promise<CallHierarchyOutgoingCall[]> {
        const calls = new Map<string, CallHierarchyOutgoingCall>();
        const addCall = (target: Method, range: CallHierarchyOutgoingCall['fromRanges'][number]) => {
            const document = AstUtils.getDocument(target);
            const to = this.createItem(target, document);
            if (!to) {
                return;
            }
            const key = `${to.uri}\u0000${to.selectionRange.start.line}:${to.selectionRange.start.character}`;
            const existing = calls.get(key);
            if (existing) {
                existing.fromRanges.push(range);
            } else {
                calls.set(key, { to, fromRanges: [range] });
            }
        };

        if (isJourney(node)) {
            for (const step of allJourneySteps(node)) {
                const target = step.target?.ref;
                const range = step.$cstNode?.range;
                if (isMethod(target) && range) {
                    addCall(target, range);
                }
            }
            return [...calls.values()];
        }
        if (!isMethod(node)) {
            return [];
        }
        for (const invocation of node.invocations) {
            const target = invocation.target?.ref;
            const range = invocation.$cstNode?.range;
            if (isMethod(target) && range) {
                addCall(target, range);
            }
        }
        return [...calls.values()];
    }

    private createItem(node: AstNode, document: LangiumDocument): CallHierarchyItem | undefined {
        return this.getCallHierarchyItems(node, document)?.[0];
    }

    private async resolveItemTarget(
        item: CallHierarchyItem
    ): Promise<{ node: AstNode; document: LangiumDocument } | undefined> {
        const document = await this.documents.getOrCreateDocument(URI.parse(item.uri));
        const root = document.parseResult.value.$cstNode;
        if (!root) {
            return undefined;
        }
        const leaf = CstUtils.findDeclarationNodeAtOffset(
            root,
            document.textDocument.offsetAt(item.selectionRange.start),
            this.grammarConfig.nameRegexp
        );
        const node = leaf ? this.references.findDeclarations(leaf)[0] : undefined;
        return node ? { node, document } : undefined;
    }
}

function* allJourneySteps(journey: Journey): Generator<JourneyStep> {
    for (const actor of journey.actors) {
        yield* actor.steps;
    }
}
