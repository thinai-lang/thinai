import { AstUtils, isReference, type Reference } from 'langium';
import type { CollectionType, TypeDeclaration } from './generated/ast.js';

/** Collects all type references in a direct type or recursively nested collection type. */
export function getTypeReferences(
    type?: Reference<TypeDeclaration>,
    collection?: CollectionType
): Reference<TypeDeclaration>[] {
    return [
        ...(type ? [type] : []),
        ...(collection
            ? AstUtils.streamReferences(collection)
                .map(referenceInfo => isReference(referenceInfo.reference)
                    ? referenceInfo.reference as Reference<TypeDeclaration>
                    : undefined
                )
                .filter((reference): reference is Reference<TypeDeclaration> => reference !== undefined)
                .toArray()
            : [])
    ];
}

export interface CollectionTypeFormatOptions {
    missingType?: string;
    mapSeparator?: string;
}

/** Formats recursively nested Thinai collection types with caller-specific type names and punctuation. */
export function formatCollectionType(
    collection: CollectionType | undefined,
    getReferenceName: (reference: Reference<TypeDeclaration>) => string,
    options: CollectionTypeFormatOptions = {}
): string {
    const missingType = options.missingType ?? 'unknown';
    if (!collection) {
        return missingType;
    }
    const formatMember = (
        primitive: string | undefined,
        reference: Reference<TypeDeclaration> | undefined,
        nested: CollectionType | undefined
    ): string => primitive ?? (reference?.ref
        ? getReferenceName(reference)
        : nested ? formatCollectionType(nested, getReferenceName, options) : missingType);

    const element = formatMember(collection.elementPrimitive, collection.elementType, collection.elementCollection);
    if (collection.kind !== 'Map') {
        return `${collection.kind}<${element}>`;
    }
    const value = formatMember(collection.valuePrimitive, collection.valueType, collection.valueCollection);
    return `Map<${element}${options.mapSeparator ?? ', '}${value}>`;
}
