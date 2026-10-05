import { isLeafCstNode, type AstNode } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';

const blockTypes = new Set([
    'BoundedContext',
    'BoundedContextPart',
    'ContextMap',
    'SharedKernelRelationship',
    'ApplicationService',
    'SharedKernel',
    'Module',
    'Aggregate',
    'Entity',
    'ValueObject',
    'EnumType',
    'ReadModel',
    'DataObject',
    'Projector',
    'DomainService',
    'Method',
    'Constructor',
    'QueryService',
    'Factory',
    'DomainEvent',
    'IntegrationEvent',
    'Journey',
    'JourneyActor'
]);

const commaSeparatedTypes = new Set([
    'Import',
    'ContextMap',
    'SharedKernelRelationship',
    'ContextMapEndpoint',
    'Exposure',
    'Method',
    'Transition',
    'EventEmission',
    'CollectionType'
]);

const relationshipTypes = new Set([
    'CustomerSupplierRelationship',
    'PartnershipRelationship',
    'SeparateWaysRelationship'
]);

/** Formatting rules for Thinai source documents. */
export class ThinaiFormatter extends AbstractFormatter {
    private isFormattingRange = false;

    override formatDocumentRange(...args: Parameters<AbstractFormatter['formatDocumentRange']>) {
        return this.withRangeFormatting(() => super.formatDocumentRange(...args));
    }

    override formatDocumentOnType(...args: Parameters<AbstractFormatter['formatDocumentOnType']>) {
        return this.withRangeFormatting(() => super.formatDocumentOnType(...args));
    }

    protected override format(node: AstNode): void {
        const formatter = this.getNodeFormatter(node);

        formatter.keywords(':').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        formatter.keywords('.').surround(Formatting.noSpace());
        formatter.keywords('(').prepend(Formatting.noSpace());
        formatter.keywords(')').prepend(Formatting.noSpace());
        if (commaSeparatedTypes.has(node.$type)) {
            formatter.keywords(',').append(Formatting.oneSpace());
        }
        if (relationshipTypes.has(node.$type)) {
            formatter.keywords('->', '<->', '-x-').surround(Formatting.oneSpace());
        }
        if (node.$type === 'Method') {
            formatter.keyword('returns').prepend(Formatting.oneSpace());
        }
        if (node.$type === 'JourneyStep') {
            formatter.keywords('with', 'when').prepend(Formatting.indent());
        }
        if (node.$type === 'Transition' || node.$type === 'EventEmission') {
            formatter.keyword('when').prepend(Formatting.oneSpace());
        }
        if (node.$type === 'EventEmission') {
            formatter.keyword('emits').append(Formatting.oneSpace());
        }
        if (node.$type === 'CollectionType') {
            formatter.keywords('<', '>').surround(Formatting.noSpace());
        }

        if (blockTypes.has(node.$type)) {
            const open = formatter.keyword('{');
            const close = formatter.keyword('}');
            const children = this.getBlockChildren(node);
            open.prepend(Formatting.oneSpace());
            if (children.length > 0 || node.$type === 'SharedKernelRelationship') {
                formatter.nodes(...children).prepend(Formatting.indent());
                const interior = formatter.interior(open, close);
                const comments = interior.nodes.filter(cstNode => isLeafCstNode(cstNode) &&
                    (cstNode.tokenType.name === 'SL_COMMENT' || cstNode.tokenType.name === 'ML_COMMENT')
                );
                formatter.cst(comments).prepend(Formatting.indent());
                if (node.$type === 'SharedKernelRelationship') {
                    formatter.keyword('participants').prepend(Formatting.indent());
                }
                if (node.$type === 'Method') {
                    formatter.keyword('projects').prepend(Formatting.indent());
                    formatter.keyword('projects').append(Formatting.oneSpace());
                }
                close.prepend(Formatting.newLine());
            }
        }

        if (node.$type === 'Entity' || node.$type === 'ValueObject') {
            const declaration = node as AstNode & {
                constructors?: AstNode[];
                methods?: AstNode[];
                fields?: AstNode[];
            };
            this.separateGroup(formatter, declaration.constructors, declaration.methods);
            this.separateGroup(
                formatter,
                declaration.methods?.length ? declaration.methods : declaration.constructors,
                declaration.fields
            );
            this.separateSiblings(formatter, declaration.constructors);
            this.separateSiblings(formatter, declaration.methods);
        } else if (['ApplicationService', 'Projector', 'DomainService', 'QueryService', 'Factory'].includes(node.$type)) {
            const declaration = node as AstNode & { methods?: AstNode[] };
            this.separateSiblings(formatter, declaration.methods);
        } else if (node.$type === 'Module') {
            const module = node as AstNode & { exposures?: AstNode[]; members?: AstNode[] };
            this.separateGroup(formatter, module.exposures, module.members);
            this.separateSiblings(formatter, module.members);
        }

        if (['BoundedContext', 'BoundedContextPart', 'SharedKernel'].includes(node.$type)) {
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
            if (declarations.length > firstToSeparate) {
                formatter.nodes(...declarations.slice(firstToSeparate)).prepend(Formatting.newLines(2));
            }
        }
    }

    private separateSiblings(formatter: ReturnType<ThinaiFormatter['getNodeFormatter']>, nodes?: AstNode[]): void {
        if (nodes && nodes.length > 1) {
            formatter.nodes(...nodes.slice(1)).prepend(this.blankLineIndent());
        }
    }

    private separateGroup(
        formatter: ReturnType<ThinaiFormatter['getNodeFormatter']>,
        previous?: AstNode[],
        next?: AstNode[]
    ): void {
        if (previous?.length && next?.length) {
            formatter.node(next[0]).prepend(this.blankLineIndent());
        }
    }

    private blankLineIndent() {
        return { options: {}, moves: [{ lines: 2, tabs: 1 }] };
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
            case 'BoundedContext':
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
                ];
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
