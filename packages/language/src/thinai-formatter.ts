import { CstUtils, isCompositeCstNode, isLeafCstNode, type AstNode } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';
import { getBlockNestingDepth, isBlockNodeType } from './thinai-layout.js';

const commaSeparatedTypes = new Set([
    'Import',
    'BoundedContext',
    'Module',
    'ContextMap',
    'SharedKernelRelationship',
    'ContextMapEndpoint',
    'Exposure',
    'Method',
    'Constructor',
    'Transition',
    'EventEmission',
    'CollectionType'
]);

const relationshipTypes = new Set([
    'CustomerSupplierRelationship',
    'PartnershipRelationship',
    'SeparateWaysRelationship'
]);

const keywordPairs = [
    'bounded', 'application', 'domain', 'query', 'shared', 'value', 'read', 'data', 'integration', 'context'
];

const keywordValueSeparators = [
    'aggregate', 'actor', 'by', 'depends', 'emits', 'enum', 'event', 'exposes', 'factory', 'from',
    'in', 'invariant', 'integration', 'invokes', 'invoke', 'journey', 'kind', 'manages', 'method',
    'kernel', 'map', 'model', 'module', 'object', 'on', 'postcondition', 'precondition', 'projector', 'projects', 'realizes',
    'repository', 'service',
    'returns', 'root', 'separateWays', 'serves', 'subdomain', 'supplier', 'customer', 'partner',
    'sharedKernel', 'to', 'transition', 'when', 'with'
];

/** Formatting rules for Thinai source documents. */
export class ThinaiFormatter extends AbstractFormatter {
    private isFormattingRange = false;
    private readonly continuationColumns = new Map<string, { indentation: number; prefixLength: number }>();

    override formatDocumentRange(...args: Parameters<AbstractFormatter['formatDocumentRange']>) {
        return this.withRangeFormatting(() => super.formatDocumentRange(...args));
    }

    override formatDocumentOnType(...args: Parameters<AbstractFormatter['formatDocumentOnType']>) {
        return this.withRangeFormatting(() => super.formatDocumentOnType(...args));
    }

    protected override doDocumentFormat(...args: Parameters<AbstractFormatter['doDocumentFormat']>) {
        this.continuationColumns.clear();
        return super.doDocumentFormat(...args);
    }

    protected override createLineTextEdit(...args: Parameters<AbstractFormatter['createLineTextEdit']>) {
        const [range, lines, context, options] = args;
        const alignment = this.continuationColumns.get(`${range.end.line}:${range.end.character}`);
        if (!alignment) {
            return super.createLineTextEdit(...args);
        }

        const lineCount = this.fitIntoOptions(lines, range.end.line - range.start.line, options);
        const tabSize = context.options.tabSize;
        const column = alignment.indentation * tabSize + alignment.prefixLength;
        const indentation = context.options.insertSpaces
            ? ' '.repeat(column)
            : '\t'.repeat(Math.floor(column / tabSize)) + ' '.repeat(column % tabSize);
        return { range, newText: `${'\n'.repeat(lineCount)}${indentation}` };
    }

    protected override format(node: AstNode): void {
        const formatter = this.getNodeFormatter(node);

        formatter.keywords(':').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        formatter.keywords('.').surround(Formatting.noSpace());
        formatter.keywords('(').prepend(Formatting.noSpace());
        formatter.keywords(')').prepend(Formatting.noSpace());
        for (const keyword of keywordPairs) {
            formatter.keyword(keyword).append(Formatting.oneSpace());
        }
        formatter.keywords(...keywordValueSeparators).append(Formatting.oneSpace());
        formatter.keywords(
            'depends', 'from', 'initial', 'kind', 'manages', 'mirrors', 'on', 'realizes', 'returns', 'serves', 'to'
        ).prepend(Formatting.oneSpace());
        formatter.keyword('initial').surround(Formatting.oneSpace());
        if (commaSeparatedTypes.has(node.$type)) {
            formatter.keywords(',').prepend(Formatting.noSpace());
            if (node.$type === 'Transition') {
                formatter.keyword(',').append(Formatting.indent());
            } else if (node.$type !== 'EventEmission' && node.$type !== 'Method') {
                formatter.keywords(',').append(Formatting.oneSpace());
            }
        }
        if (node.$type === 'EnumType') {
            formatter.keywords(',').prepend(Formatting.noSpace());
        }
        if (node.$type === 'Import') {
            formatter.keyword('import').append(Formatting.oneSpace());
            formatter.keyword('{').append(Formatting.oneSpace());
            formatter.keyword('}').prepend(Formatting.oneSpace());
            formatter.keyword('as').surround(Formatting.oneSpace());
            formatter.keyword('from').surround(Formatting.oneSpace());
        }
        if (node.$type === 'SharedKernelRelationship' || node.$type === 'ContextMapEndpoint') {
            formatter.keyword('[').append(Formatting.noSpace());
            formatter.keyword(']').prepend(Formatting.noSpace());
        }
        if (relationshipTypes.has(node.$type)) {
            formatter.keywords('->', '<->', '-x-').surround(Formatting.oneSpace());
        }
        if (node.$type === 'Method') {
            const method = node as AstNode & { parameters?: AstNode[]; projects?: AstNode[] };
            formatter.keyword('returns').surround(Formatting.oneSpace());
            formatter.nodes(...(method.parameters ?? []).slice(1)).prepend(Formatting.oneSpace());
            formatter.nodes(...(method.projects ?? []).slice(1)).prepend(Formatting.oneSpace());
        }
        if (node.$type === 'JourneyStep') {
            formatter.keywords('with', 'when').prepend(Formatting.indent());
            formatter.keywords('with', 'when').append(Formatting.oneSpace());
        }
        if (node.$type === 'Transition') {
            const transition = node as AstNode & { changes?: AstNode[] };
            const changes = transition.changes ?? [];
            const alignment = {
                indentation: this.getBlockIndentation(node),
                prefixLength: 'transition '.length
            };
            for (const change of changes.slice(1)) {
                const start = change.$cstNode?.range.start;
                if (start) {
                    this.continuationColumns.set(`${start.line}:${start.character}`, alignment);
                }
            }
            formatter.keyword('when').prepend(Formatting.indent());
            formatter.keyword('when').append(Formatting.oneSpace());
            this.alignKeyword(node, 'when', this.getBlockIndentation(node) + 1);
        }
        if (node.$type === 'EventEmission') {
            const emission = node as AstNode & { events?: AstNode[] };
            const events = emission.events ?? [];
            formatter.nodes(...events.slice(1)).prepend(Formatting.indent({ priority: 1 }));
            const alignment = {
                indentation: this.getBlockIndentation(node),
                prefixLength: 'emits '.length
            };
            for (const event of events.slice(1)) {
                const start = event.$cstNode?.range.start;
                if (start) {
                    this.continuationColumns.set(`${start.line}:${start.character}`, alignment);
                }
            }
            formatter.keyword('when').prepend(Formatting.indent());
            formatter.keyword('when').append(Formatting.oneSpace());
            this.alignKeyword(node, 'when', this.getBlockIndentation(node) + 1);
        }
        if (node.$type === 'MethodInvocation') {
            formatter.keyword('when').prepend(Formatting.indent());
            formatter.keyword('when').append(Formatting.oneSpace());
            this.alignKeyword(node, 'when', this.getBlockIndentation(node) + 1);
        }
        if (node.$type === 'EventEmission') {
            formatter.keyword('emits').append(Formatting.oneSpace());
        }
        if (node.$type === 'CollectionType') {
            formatter.keywords('<', '>').surround(Formatting.noSpace());
        }

        if (isBlockNodeType(node.$type)) {
            const open = formatter.keyword('{');
            const close = formatter.keyword('}');
            const children = this.getBlockChildren(node);
            open.prepend(Formatting.oneSpace());
            const interior = formatter.interior(open, close);
            const comments = interior.nodes.filter(cstNode => isLeafCstNode(cstNode) &&
                (cstNode.tokenType.name === 'SL_COMMENT' || cstNode.tokenType.name === 'ML_COMMENT')
            );
            if (children.length > 0 || comments.length > 0 ||
                node.$type === 'SharedKernelRelationship' || node.$type === 'ContextMapEndpoint') {
                formatter.nodes(...children).prepend(Formatting.indent());
                formatter.cst(comments).prepend(Formatting.indent());
                if (node.$type === 'SharedKernelRelationship') {
                    formatter.keyword('participants').prepend(Formatting.indent());
                }
                if (node.$type === 'ContextMapEndpoint') {
                    formatter.keyword('integrationPatterns').prepend(Formatting.indent());
                }
                if (node.$type === 'Method') {
                    formatter.keyword('projects').prepend(Formatting.indent());
                    formatter.keyword('projects').append(Formatting.oneSpace());
                }
                close.prepend(Formatting.newLine());
            } else {
                open.append(Formatting.noSpace());
                close.prepend(Formatting.noSpace());
            }
        }

        if (node.$type === 'Entity' || node.$type === 'ValueObject') {
            const declaration = node as AstNode & {
                constructors?: AstNode[];
                methods?: AstNode[];
                fields?: AstNode[];
            };
            const members = [
                ...(declaration.constructors ?? []),
                ...(declaration.methods ?? []),
                ...(declaration.fields ?? [])
            ].sort((left, right) => (left.$cstNode?.offset ?? 0) - (right.$cstNode?.offset ?? 0));
            this.separateOrderedMembers(formatter, members);
        } else if (['ApplicationService', 'Projector', 'DomainService', 'QueryService', 'Factory'].includes(node.$type)) {
            const declaration = node as AstNode & { methods?: AstNode[] };
            this.separateSiblings(formatter, declaration.methods);
        } else if (node.$type === 'Module') {
            const module = node as AstNode & { exposures?: AstNode[]; members?: AstNode[] };
            this.separateGroup(formatter, module.exposures, module.members);
            this.separateSiblings(formatter, module.members);
        }

        if (['BoundedContextPart', 'SharedKernel'].includes(node.$type)) {
            const declaration = node as AstNode & { members?: AstNode[] };
            this.separateSiblings(formatter, declaration.members);
        } else if (node.$type === 'Aggregate') {
            const aggregate = node as AstNode & { members?: AstNode[]; invariants?: AstNode[] };
            this.separateSiblings(formatter, [...(aggregate.members ?? []), ...(aggregate.invariants ?? [])]
                .sort((left, right) => (left.$cstNode?.offset ?? 0) - (right.$cstNode?.offset ?? 0)));
        } else if (node.$type === 'ContextMap') {
            const contextMap = node as AstNode & { relationships?: AstNode[] };
            this.separateSiblings(formatter, contextMap.relationships);
        } else if (node.$type === 'Journey') {
            const journey = node as AstNode & { actors?: AstNode[] };
            this.separateSiblings(formatter, journey.actors);
        }

        if (node.$type === 'Model' && !this.isFormattingRange) {
            const model = node as AstNode & { imports?: AstNode[]; declarations?: AstNode[] };
            const declarations = model.declarations ?? [];
            const firstToSeparate = model.imports?.length ? 0 : 1;
            for (let index = firstToSeparate; index < declarations.length; index++) {
                const previous = index > 0
                    ? declarations[index - 1]
                    : model.imports?.at(-1);
                this.prependSiblingSpacing(formatter, previous, declarations[index]!, Formatting.newLines(2));
            }
        }
    }

    private separateSiblings(formatter: ReturnType<ThinaiFormatter['getNodeFormatter']>, nodes?: AstNode[]): void {
        if (nodes && nodes.length > 1) {
            for (let index = 1; index < nodes.length; index++) {
                this.prependSiblingSpacing(formatter, nodes[index - 1], nodes[index]!, this.blankLineIndent());
            }
        }
    }

    private separateOrderedMembers(formatter: ReturnType<ThinaiFormatter['getNodeFormatter']>, nodes: AstNode[]): void {
        for (let index = 1; index < nodes.length; index++) {
            const previous = nodes[index - 1]!;
            const current = nodes[index]!;
            if (previous.$type === 'Field' && current.$type === 'Field') {
                continue;
            }
            this.prependSiblingSpacing(formatter, previous, current, this.blankLineIndent());
        }
    }

    private separateGroup(
        formatter: ReturnType<ThinaiFormatter['getNodeFormatter']>,
        previous?: AstNode[],
        next?: AstNode[]
    ): void {
        if (previous?.length && next?.length) {
            this.prependSiblingSpacing(formatter, previous.at(-1), next[0]!, this.blankLineIndent());
        }
    }

    private prependSiblingSpacing(
        formatter: ReturnType<ThinaiFormatter['getNodeFormatter']>,
        previous: AstNode | undefined,
        next: AstNode,
        spacing: ReturnType<typeof Formatting.newLine>
    ): void {
        const parentCst = next.$container?.$cstNode;
        const previousCst = previous?.$cstNode;
        const nextCst = next.$cstNode;
        if (!parentCst || !nextCst) {
            formatter.node(next).prepend(spacing);
            return;
        }
        const gapStart = previousCst?.end ?? parentCst.offset;
        const leadingComments = CstUtils.flattenCst(parentCst).filter(comment =>
            (comment.tokenType.name === 'SL_COMMENT' || comment.tokenType.name === 'ML_COMMENT') &&
            comment.offset >= gapStart && comment.end <= nextCst.offset &&
            (!previousCst || comment.range.start.line > previousCst.range.end.line)
        ).toArray();
        const firstLeadingComment = leadingComments[0];
        if (firstLeadingComment) {
            formatter.cst([firstLeadingComment]).prepend({
                ...spacing,
                options: { ...spacing.options, priority: (spacing.options.priority ?? 0) + 1 }
            });
        } else {
            formatter.node(next).prepend(spacing);
        }
    }

    private blankLineIndent() {
        return { options: {}, moves: [{ lines: 2, tabs: 1 }] };
    }

    private getBlockIndentation(node: AstNode): number {
        return getBlockNestingDepth(node.$container);
    }

    private alignKeyword(node: AstNode, keyword: string, indentation: number): void {
        const cstNode = node.$cstNode;
        if (!cstNode || !isCompositeCstNode(cstNode)) {
            return;
        }
        const keywordNode = CstUtils.flattenCst(cstNode).find(leaf => leaf.text === keyword);
        const start = keywordNode?.range.start;
        if (start) {
            this.continuationColumns.set(`${start.line}:${start.character}`, { indentation, prefixLength: 0 });
        }
    }

    private getBlockChildren(node: AstNode): AstNode[] {
        const properties = node as AstNode & {
            members?: AstNode[];
            invariants?: AstNode[];
            constructors?: AstNode[];
            methods?: AstNode[];
            fields?: AstNode[];
            values?: AstNode[];
            relationships?: AstNode[];
            exposures?: AstNode[];
            declarations?: AstNode[];
            actors?: AstNode[];
            steps?: AstNode[];
            preconditions?: AstNode[];
            postconditions?: AstNode[];
            behaviors?: AstNode[];
            transitions?: AstNode[];
            emissions?: AstNode[];
            changes?: AstNode[];
            events?: AstNode[];
            invocations?: AstNode[];
        };

        let children: AstNode[];
        switch (node.$type) {
            case 'BoundedContextPart':
            case 'SharedKernel':
                children = properties.members ?? [];
                break;
            case 'Aggregate':
                children = [...(properties.members ?? []), ...(properties.invariants ?? [])];
                break;
            case 'Entity':
            case 'ValueObject':
                children = [
                    ...(properties.constructors ?? []),
                    ...(properties.methods ?? []),
                    ...(properties.fields ?? [])
                ].sort((left, right) => (left.$cstNode?.offset ?? 0) - (right.$cstNode?.offset ?? 0));
                break;
            case 'EnumType':
                children = properties.values ?? [];
                break;
            case 'ContextMap':
                children = properties.relationships ?? [];
                break;
            case 'Module':
                children = [...(properties.exposures ?? []), ...(properties.members ?? [])];
                break;
            case 'ApplicationService':
            case 'Projector':
            case 'DomainService':
            case 'QueryService':
            case 'Factory':
                children = properties.methods ?? [];
                break;
            case 'ReadModel':
            case 'DataObject':
            case 'DomainEvent':
            case 'IntegrationEvent':
                children = properties.fields ?? [];
                break;
            case 'Method':
                children = [
                    ...(properties.invariants ?? []),
                    ...(properties.preconditions ?? []),
                    ...(properties.postconditions ?? []),
                    ...(properties.behaviors ?? []),
                    ...(properties.transitions ?? []),
                    ...(properties.emissions ?? []),
                    ...(properties.invocations ?? [])
                ];
                break;
            case 'Transition':
                children = properties.changes ?? [];
                break;
            case 'EventEmission':
                children = properties.events ?? [];
                break;
            case 'Constructor':
                children = [
                    ...(properties.invariants ?? []),
                    ...(properties.preconditions ?? []),
                    ...(properties.postconditions ?? []),
                    ...(properties.behaviors ?? [])
                ];
                break;
            case 'Journey':
                children = properties.actors ?? [];
                break;
            case 'JourneyActor':
                children = properties.steps ?? [];
                break;
            default:
                children = [];
        }
        return children.sort((left, right) => (left.$cstNode?.offset ?? 0) - (right.$cstNode?.offset ?? 0));
    }

    private withRangeFormatting<T>(format: () => T): T {
        const previous = this.isFormattingRange;
        this.isFormattingRange = true;
        try {
            return format();
        } finally {
            this.isFormattingRange = previous;
        }
    }
}
