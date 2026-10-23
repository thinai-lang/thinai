import type { AstNode, AstNodeDescription } from 'langium';
import {
    isDomainEvent,
    isEnumValue,
    isField,
    isIntegrationEvent,
    isMethod,
    isParameter,
    type CollectionType,
    type Field,
    type Parameter
} from './generated/ast.js';
import { getExportedName } from './thinai-scope-utils.js';
import { formatCollectionType } from './thinai-type-utils.js';

/** Builds concise symbol and type details for Thinai completion items. */
export class ThinaiCompletionDetails {
    getCompletionDetail(description: AstNodeDescription): string {
        const node = description.node;
        if (!node) {
            return `${description.type} ${description.name}`;
        }
        const name = isParameter(node)
            ? description.name
            : this.getCanonicalName(node, description.name);
        if (isMethod(node)) {
            const parameters = node.parameters.map(parameter => this.getParameterDetail(parameter)).join(', ');
            const result = node.returnPrimitive ??
                (node.returnType?.ref ? this.getCanonicalName(node.returnType.ref, node.returnType.$refText) :
                    node.returnCollection ? this.getCollectionDetail(node.returnCollection) : undefined);
            return `Method ${name}(${parameters})${result ? ` returns ${result}` : ''}`;
        }
        if (isField(node)) {
            return `Field ${name}${node.optional ? '?' : ''}: ${this.getTypeDetail(node)}`;
        }
        if (isParameter(node)) {
            return `Parameter ${this.getParameterDetail(node)}`;
        }
        if (isEnumValue(node)) {
            const enumName = this.getCanonicalName(node.$container, node.$container.name);
            return `Enum value ${name} (${enumName})`;
        }
        return `${description.type} ${name}`;
    }

    private getCanonicalName(node: AstNode, fallback: string): string {
        if (!('name' in node) || typeof node.name !== 'string') {
            return fallback;
        }
        return getExportedName(node as AstNode & { name: string }) || node.name;
    }

    private getParameterDetail(parameter: Parameter): string {
        const optional = parameter.optional ? '?' : '';
        const parameterTarget = parameter.type?.ref;
        const type = parameter.primitive ??
            (isDomainEvent(parameterTarget) || isIntegrationEvent(parameterTarget)
                ? `event ${this.getCanonicalName(parameterTarget, parameter.type!.$refText)}`
                : parameterTarget ? this.getCanonicalName(parameterTarget, parameter.type!.$refText) :
                    parameter.collection ? this.getCollectionDetail(parameter.collection) : 'unknown');
        return `${parameter.name}${optional}: ${type}`;
    }

    private getTypeDetail(field: Field): string {
        return field.primitive ??
            (field.type?.ref ? this.getCanonicalName(field.type.ref, field.type.$refText) :
                field.collection ? this.getCollectionDetail(field.collection) : 'unknown');
    }

    private getCollectionDetail(collection: CollectionType): string {
        return formatCollectionType(collection, reference =>
            this.getCanonicalName(reference.ref!, reference.$refText)
        );
    }
}
