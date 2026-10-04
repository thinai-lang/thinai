import type { AstNode, AstNodeDescription } from 'langium';
import { DefaultNodeKindProvider } from 'langium/lsp';
import { CompletionItemKind, SymbolKind } from 'vscode-languageserver';

/** Supplies meaningful standard LSP kinds for Thinai symbols and completions. */
export class ThinaiNodeKindProvider extends DefaultNodeKindProvider {
    override getCompletionItemKind(node: AstNode | AstNodeDescription): CompletionItemKind {
        switch (this.getType(node)) {
            case 'Aggregate':
            case 'Entity':
                return CompletionItemKind.Class;
            case 'ValueObject':
            case 'DataObject':
            case 'ReadModel':
                return CompletionItemKind.Struct;
            case 'EnumType':
                return CompletionItemKind.Enum;
            case 'EnumValue':
                return CompletionItemKind.EnumMember;
            case 'Field':
                return CompletionItemKind.Field;
            case 'Parameter':
                return CompletionItemKind.Variable;
            case 'Method':
                return CompletionItemKind.Method;
            case 'DomainEvent':
            case 'IntegrationEvent':
                return CompletionItemKind.Event;
            case 'Repository':
            case 'QueryRepository':
                return CompletionItemKind.Interface;
            case 'Module':
            case 'BoundedContext':
            case 'BoundedContextPart':
            case 'SharedKernel':
            case 'Subdomain':
            case 'ContextMap':
                return CompletionItemKind.Module;
            case 'Journey':
                return CompletionItemKind.Function;
            case 'Actor':
                return CompletionItemKind.Variable;
            case 'ApplicationService':
            case 'DomainService':
            case 'QueryService':
            case 'Projector':
            case 'Factory':
                return CompletionItemKind.Class;
            default:
                return CompletionItemKind.Reference;
        }
    }

    override getSymbolKind(node: AstNode | AstNodeDescription): SymbolKind {
        switch (this.getType(node)) {
            case 'Aggregate':
            case 'Entity':
                return SymbolKind.Class;
            case 'ValueObject':
            case 'DataObject':
            case 'ReadModel':
                return SymbolKind.Struct;
            case 'EnumType':
                return SymbolKind.Enum;
            case 'EnumValue':
                return SymbolKind.EnumMember;
            case 'Field':
                return SymbolKind.Field;
            case 'Parameter':
                return SymbolKind.Variable;
            case 'Method':
                return SymbolKind.Method;
            case 'DomainEvent':
            case 'IntegrationEvent':
                return SymbolKind.Event;
            case 'Repository':
            case 'QueryRepository':
                return SymbolKind.Interface;
            case 'Module':
            case 'BoundedContext':
            case 'BoundedContextPart':
            case 'SharedKernel':
            case 'Subdomain':
            case 'ContextMap':
                return SymbolKind.Namespace;
            case 'Journey':
                return SymbolKind.Function;
            case 'Actor':
                return SymbolKind.Object;
            case 'ApplicationService':
            case 'DomainService':
            case 'QueryService':
            case 'Projector':
            case 'Factory':
                return SymbolKind.Class;
            default:
                return SymbolKind.Variable;
        }
    }

    private getType(node: AstNode | AstNodeDescription): string {
        return '$type' in node ? node.$type : node.type;
    }
}
