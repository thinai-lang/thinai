import { AstUtils, isReference, type AstNode } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver';
import type { ThinaiServices } from './thinai-module.js';

export class ThinaiSemanticTokenProvider extends AbstractSemanticTokenProvider {
    private readonly nameProvider: ThinaiServices['references']['NameProvider'];

    constructor(services: ThinaiServices) {
        super(services);
        this.nameProvider = services.references.NameProvider;
    }

    protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        const declarationType = this.getSemanticType(node);
        const nameNode = this.nameProvider.getNameNode(node);
        if (declarationType && nameNode) {
            acceptor({ range: nameNode.range, type: declarationType, modifier: 'declaration' });
        }

        for (const info of AstUtils.streamReferences(node)) {
            if (!isReference(info.reference) || !info.reference.ref || !info.reference.$refNode) {
                continue;
            }
            const referenceType = this.getSemanticType(info.reference.ref);
            if (referenceType) {
                acceptor({ range: info.reference.$refNode.range, type: referenceType });
            }
        }
    }

    private getSemanticType(node: AstNode): string | undefined {
        switch (node.$type) {
            case 'Aggregate':
            case 'Entity':
                return SemanticTokenTypes.class;
            case 'ValueObject':
            case 'DataObject':
            case 'ReadModel':
                return SemanticTokenTypes.struct;
            case 'EnumType':
                return SemanticTokenTypes.enum;
            case 'EnumValue':
                return SemanticTokenTypes.enumMember;
            case 'Method':
                return SemanticTokenTypes.method;
            case 'Field':
                return SemanticTokenTypes.property;
            case 'Parameter':
                return SemanticTokenTypes.parameter;
            case 'DomainEvent':
            case 'IntegrationEvent':
                return SemanticTokenTypes.event;
            case 'Repository':
            case 'QueryRepository':
                return SemanticTokenTypes.interface;
            case 'BoundedContext':
            case 'SharedKernel':
            case 'Subdomain':
            case 'ContextMap':
            case 'Module':
                return SemanticTokenTypes.namespace;
            case 'ApplicationService':
            case 'DomainService':
            case 'QueryService':
            case 'Projector':
            case 'Factory':
                return SemanticTokenTypes.class;
            case 'Journey':
                return SemanticTokenTypes.function;
            case 'Actor':
                return SemanticTokenTypes.variable;
            default:
                return undefined;
        }
    }
}
