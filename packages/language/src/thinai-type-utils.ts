import { AstUtils, isReference, type Reference } from 'langium';
import type { CollectionType, TypeDeclaration } from './generated/ast.js';

/** Collects all type references in a direct type or recursively nested collection type. */
export function getTypeReferences(
    type?: Reference<TypeDeclaration>,
    collection?: CollectionType
): Reference<TypeDeclaration>[] {
    const references: Reference<TypeDeclaration>[] = [];
    if (type) {
        references.push(type);
    }
    if (collection) {
        collectCollectionReferences(collection, references);
    }
    return references;
}

/**
 * Collects the type references a specification path may traverse. Collection
 * paths follow their element/value type; map paths follow the value type only,
 * because keys are identity rather than navigable data.
 */
export function getNavigableTypeReferences(
    type?: Reference<TypeDeclaration>,
    collection?: CollectionType
): Reference<TypeDeclaration>[] {
    const references: Reference<TypeDeclaration>[] = [];
    if (type) {
        references.push(type);
    }
    if (collection) {
        collectNavigableCollectionReferences(collection, references);
    }
    return references;
}

function collectNavigableCollectionReferences(
    collection: CollectionType,
    references: Reference<TypeDeclaration>[]
): void {
    const reference = collection.kind === 'Map' ? collection.valueType : collection.elementType;
    if (reference) {
        references.push(reference);
    }
    const nested = collection.kind === 'Map' ? collection.valueCollection : collection.elementCollection;
    if (nested) {
        collectNavigableCollectionReferences(nested, references);
    }
}

function collectCollectionReferences(
    collection: CollectionType,
    references: Reference<TypeDeclaration>[]
): void {
    for (const referenceInfo of AstUtils.streamReferences(collection)) {
        if (referenceInfo.property?.endsWith('Path') || !isReference(referenceInfo.reference)) {
            continue;
        }
        references.push(referenceInfo.reference as Reference<TypeDeclaration>);
    }
    if (collection.elementCollection) {
        collectCollectionReferences(collection.elementCollection, references);
    }
    if (collection.valueCollection) {
        collectCollectionReferences(collection.valueCollection, references);
    }
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
