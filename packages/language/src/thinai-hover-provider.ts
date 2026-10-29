import { type AstNode } from 'langium';
import { AstNodeHoverProvider } from 'langium/lsp';
import { getExportedName } from './thinai-scope-utils.js';
import type { ThinaiServices } from './thinai-module.js';

/** Provides declaration identity for both declarations and resolved references. */
export class ThinaiHoverProvider extends AstNodeHoverProvider {
    constructor(services: ThinaiServices) {
        super(services);
    }

    protected getAstNodeHoverContent(node: AstNode): string | undefined {
        const name = hoverName(node);
        if (!name) {
            return undefined;
        }
        return `**${node.$type}** \`${name}\``;
    }
}

function hoverName(node: AstNode): string | undefined {
    if (node.$type === 'Parameter') {
        const parameter = node as AstNode & { name?: string; $container?: AstNode };
        const owner = parameter.$container;
        if (parameter.name && owner) {
            const ownerName = hoverName(owner);
            return ownerName ? `${ownerName}.${parameter.name}` : parameter.name;
        }
        return parameter.name;
    }
    if (node.$type === 'Constructor') {
        const constructor = node as AstNode & { $container?: AstNode };
        const owner = constructor.$container;
        const ownerName = owner ? hoverName(owner) : undefined;
        return ownerName ? `${ownerName}.constructor` : 'constructor';
    }
    if (typeof (node as AstNode & { name?: unknown }).name !== 'string') {
        return undefined;
    }
    return getExportedName(node as AstNode & { name: string });
}
