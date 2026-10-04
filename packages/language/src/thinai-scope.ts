import {
    type AstNode,
    type AstNodeDescription,
    AstUtils,
    DefaultScopeComputation,
    DefaultScopeProvider,
    type LangiumDocument,
    type ReferenceInfo,
    type Scope,
    type Stream,
    UriUtils
} from 'langium';
import type { CancellationToken } from 'vscode-jsonrpc';
import {
    type Import,
    type Constructor,
    type DataObject,
    type FlowElement,
    type Method,
    type ReadModel,
    isConstructor,
    isBoundedContext,
    isBoundedContextPart,
    isDomainEvent,
    isDataObject,
    isEntity,
    isField,
    isFlowElement,
    isMethodInvocation,
    isIntegrationEvent,
    isModel,
    isMethod,
    isEnumType,
    isTransition,
    isModule,
    isSharedKernel,
    isImportComponent,
    isImportableComponent,
    isReadModel,
    isSpecificationTextPart,
    isQueryService,
    isValueObject,
    type Module
} from './generated/ast.js';

const exportedTypes = new Set([
    'Aggregate',
    'ApplicationService',
    'BoundedContext',
    'ContextMap',
    'Capability',
    'DomainEvent',
    'DomainService',
    'DataObject',
    'Entity',
    'EnumType',
    'EnumValue',
    'Flow',
    'Factory',
    'Field',
    'IntegrationEvent',
    'Method',
    'Module',
    'Projector',
    'QueryRepository',
    'QueryService',
    'ReadModel',
    'Repository',
    'SharedKernel',
    'Subdomain',
    'ValueObject'
]);

type NamedNode = AstNode & { name: string };

function isNamedExport(node: AstNode): node is NamedNode {
    if (isField(node) && !isEntity(node.$container) && !isValueObject(node.$container) &&
        !isDomainEvent(node.$container) && !isIntegrationEvent(node.$container) && !isReadModel(node.$container) &&
        !isDataObject(node.$container)) {
        return false;
    }
    return exportedTypes.has(node.$type) && typeof (node as Partial<NamedNode>).name === 'string';
}

export function getOwningContextName(node: AstNode): string | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isBoundedContext(current)) {
            return current.name;
        }
        if (isBoundedContextPart(current)) {
            return current.context.ref?.name ?? current.context.$refText;
        }
        if (isSharedKernel(current)) {
            return current.name;
        }
        current = current.$container;
    }
    return undefined;
}

function getContextNameForIndexing(node: AstNode): string | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isBoundedContext(current)) {
            return current.name;
        }
        if (isBoundedContextPart(current)) {
            const referenceText = current.context.$refText;
            const root = AstUtils.getDocument(current).parseResult.value;
            if (isModel(root)) {
                const selectedComponent = root.imports
                    .flatMap(importDeclaration => importDeclaration.components)
                    .find(component => component.alias === referenceText);
                if (selectedComponent) {
                    return selectedComponent.component.$refText;
                }
            }
            return referenceText;
        }
        if (isSharedKernel(current)) {
            return current.name;
        }
        current = current.$container;
    }
    return undefined;
}

function getDeclarationPath(node: NamedNode): string[] {
    const path: string[] = [];
    let current: AstNode | undefined = node;
    while (current && !isBoundedContext(current) && !isBoundedContextPart(current) && !isSharedKernel(current)) {
        if (isNamedExport(current)) {
            path.unshift(current.name);
        }
        current = current.$container;
    }
    return path;
}

export function getOwningModule(node: AstNode): Module | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isModule(current)) {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

export function isInSharedKernel(node: AstNode): boolean {
    let current: AstNode | undefined = node;
    while (current) {
        if (isSharedKernel(current)) {
            return true;
        }
        current = current.$container;
    }
    return false;
}

export function getExportedName(node: NamedNode): string {
    const contextName = getOwningContextName(node);
    const path = getDeclarationPath(node);
    return contextName ? [contextName, ...path].join('.') : path.join('.');
}

export function resolveImportUri(document: LangiumDocument, importDeclaration: Import) {
    return UriUtils.resolvePath(UriUtils.dirname(document.uri), importDeclaration.path);
}

export class ThinaiScopeComputation extends DefaultScopeComputation {
    override async collectExportedSymbols(
        document: LangiumDocument,
        _cancelToken?: CancellationToken
    ): Promise<AstNodeDescription[]> {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }

        const exports: AstNodeDescription[] = [];
        for (const node of AstUtils.streamAst(root)) {
            if (!isNamedExport(node)) {
                continue;
            }
            const contextName = getContextNameForIndexing(node);
            const path = getDeclarationPath(node as NamedNode);
            const name = contextName ? [contextName, ...path].join('.') : path.join('.');
            if (name) {
                exports.push(this.descriptions.createDescription(node, name, document));
            }
        }
        return exports;
    }
}

export class ThinaiScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        if (isTransition(context.container)) {
            if (context.property === 'field') {
                return this.getTransitionFieldScope(context.container);
            }
            if (context.property === 'from' || context.property === 'to') {
                return this.getTransitionStateScope(context.container);
            }
        }
        const referenceType = this.reflection.getReferenceType(context);
        const qualifiedPathScope = this.getQualifiedPathScope(context);
        if (qualifiedPathScope) {
            return qualifiedPathScope;
        }
        if (referenceType === 'SpecificationTarget' && context.property === 'targets' &&
            isSpecificationTextPart(context.container)) {
            return this.createScope(this.getSpecificationPathSymbols(context, referenceType));
        }
        if (context.property === 'targets' &&
            (isFlowElement(context.container) || isMethodInvocation(context.container))) {
            return this.createScope(this.getInvocationPathSymbols(context, referenceType));
        }
        if (context.property === 'component' && isImportComponent(context.container)) {
            return this.createScope(this.getImportableComponents(context.container, referenceType));
        }
        return this.getUnsegmentedScope(context, referenceType);
    }

    private getTransitionFieldScope(transition: import('./generated/ast.js').Transition): Scope {
        let current: AstNode | undefined = transition.$container;
        while (current && !isEntity(current)) {
            current = current.$container;
        }
        const fields = current && isEntity(current) ? current.fields : [];
        return this.createScope(fields.map(field =>
            this.descriptions.createDescription(field, field.name, AstUtils.getDocument(field))
        ));
    }

    private getTransitionStateScope(transition: import('./generated/ast.js').Transition): Scope {
        const enumType = transition.field.ref?.type?.ref;
        if (!isEnumType(enumType)) {
            return this.createScope([]);
        }
        const document = AstUtils.getDocument(enumType);
        return this.createScope(enumType.values.map(value =>
            this.descriptions.createDescription(value, value.name, document)
        ));
    }

    private getQualifiedPathScope(context: ReferenceInfo): Scope | undefined {
        const wrapperPath = context.property === 'path' || context.property === 'target';
        const prefixProperty = wrapperPath
            ? 'path'
            : context.property.endsWith('Path')
                ? context.property
                : `${context.property}Path`;
        const container = context.container as unknown as Record<string, unknown>;
        const prefixReferences = container[prefixProperty];
        if (!Array.isArray(prefixReferences) || prefixReferences.length === 0) {
            return undefined;
        }

        const terminalProperty = wrapperPath ? 'target' : prefixProperty.slice(0, -'Path'.length);
        const terminalReference = container[terminalProperty];
        if (!terminalReference || typeof terminalReference !== 'object' || Array.isArray(terminalReference) || !('$refText' in terminalReference)) {
            return undefined;
        }

        const pathReferences = [...prefixReferences, terminalReference] as ReferenceInfo['reference'][];
        if (!pathReferences.every(reference => reference && typeof reference === 'object' && '$refText' in reference)) {
            return undefined;
        }
        const path = pathReferences.map(reference => reference.$refText);
        const finalContext: ReferenceInfo = {
            ...context,
            property: terminalProperty,
            reference: terminalReference as ReferenceInfo['reference'],
            index: undefined
        };
        const segmentIndex = context.property === prefixProperty
            ? context.index ?? 0
            : path.length - 1;
        const completePath = path.join('.');
        const finalDescription = this.getUnsegmentedScope(
            finalContext,
            this.reflection.getReferenceType(finalContext)
        ).getElement(completePath);
        if (!finalDescription?.node) {
            return this.createScope([]);
        }

        const targetDescription = segmentIndex === path.length - 1
            ? finalDescription
            : this.getUnsegmentedScope(finalContext, 'NamedDeclaration')
                .getElement(path.slice(0, segmentIndex + 1).join('.'));
        const target = targetDescription?.node ?? this.getPathSegmentTarget(finalDescription.node, path, segmentIndex, context);
        if (!target) {
            return this.createScope([]);
        }

        return this.createScope([
            this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))
        ]);
    }

    private getUnsegmentedScope(context: ReferenceInfo, referenceType: string): Scope {
        const document = AstUtils.getDocument(context.container);
        const localScopes: Stream<AstNodeDescription>[] = [];

        if (document.localSymbols) {
            let current: AstNode | undefined = context.container;
            while (current) {
                if (document.localSymbols.has(current)) {
                    localScopes.push(document.localSymbols.getStream(current).filter(description =>
                        this.reflection.isSubtype(description.type, referenceType)
                    ));
                }
                current = current.$container;
            }
        }

        let result = this.createScope(this.getImportedSymbols(document, referenceType));
        result = this.createScope(this.getDocumentSymbols(context, document, referenceType), result);
        const moduleSymbols = context.property === 'dependencies'
            ? []
            : this.getModuleSymbols(context, referenceType);
        result = this.createScope(moduleSymbols, result);
        for (let index = localScopes.length - 1; index >= 0; index--) {
            result = this.createScope(localScopes[index], result);
        }
        const specificationSymbols = this.getSpecificationSymbols(context, referenceType);
        if (specificationSymbols.length > 0) {
            result = this.createScope(specificationSymbols, result);
        }
        return result;
    }

    private getSpecificationSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const pending: AstNodeDescription[] = [];
        if (referenceType !== 'SpecificationTarget' || !isSpecificationTextPart(context.container)) {
            return pending;
        }
        let current: AstNode | undefined = context.container;
        let operation: Method | Constructor | undefined;
        let flowElement: FlowElement | undefined;
        while (current) {
            if (isFlowElement(current)) {
                flowElement = current;
                const target = current.targets.at(-1)?.ref;
                operation = isMethod(target) ? target : undefined;
                break;
            }
            if (isMethod(current) || isConstructor(current)) {
                operation = current;
                break;
            }
            current = current.$container;
        }
        if (!operation) {
            return pending;
        }

        for (const parameter of operation.parameters) {
            this.addSpecificationSymbol(pending, parameter, parameter.name, referenceType);
            const parameterType = parameter.type?.ref;
            if (parameterType && (isDataObject(parameterType) || isReadModel(parameterType) || isValueObject(parameterType))) {
                this.addShapeFields(pending, parameterType, parameter.name, referenceType, new Set());
            }
            if (parameter.collection) {
                const elementType = parameter.collection.elementType?.ref;
                if (elementType && (isDataObject(elementType) || isReadModel(elementType) || isValueObject(elementType))) {
                    this.addShapeFields(pending, elementType, parameter.name, referenceType, new Set());
                }
            }
        }

        if (isMethod(operation)) {
            const resultType = operation.returnType?.ref;
            if (resultType || operation.returnPrimitive || operation.returnCollection) {
                this.addSpecificationSymbol(pending, operation, 'result', referenceType);
            }
            if (resultType && (isDataObject(resultType) || isReadModel(resultType) || isValueObject(resultType))) {
                this.addShapeFields(pending, resultType, 'result', referenceType, new Set());
            }
            if (operation.returnCollection) {
                const elementType = operation.returnCollection.elementType?.ref;
                if (elementType && (isDataObject(elementType) || isReadModel(elementType) || isValueObject(elementType))) {
                    this.addShapeFields(pending, elementType, 'result', referenceType, new Set());
                }
            }
        }
        if (flowElement) {
            const flowContext = getOwningContextName(flowElement);
            for (const description of this.indexManager.allElements('Method').toArray()) {
                const queryMethod = description.node;
                if (!isMethod(queryMethod) || !isQueryService(queryMethod.$container) ||
                    getOwningContextName(queryMethod) !== flowContext) {
                    continue;
                }
                const shape = queryMethod.returnType?.ref ?? queryMethod.returnCollection?.elementType?.ref;
                if (!shape || (!isDataObject(shape) && !isReadModel(shape) && !isValueObject(shape))) {
                    continue;
                }
                const resultPrefix = `${getExportedName(queryMethod as AstNode & { name: string })}.result`;
                this.addSpecificationSymbol(pending, queryMethod, resultPrefix, referenceType);
                this.addShapeFields(pending, shape, resultPrefix, referenceType, new Set());
            }
        }
        return pending;
    }

    private getSpecificationPathSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        if (!isSpecificationTextPart(context.container)) {
            return [];
        }
        const part = context.container;
        const index = context.index ?? 0;
        const reference = context.reference;
        if (index >= part.targets.length || !part.target) {
            return [];
        }

        const fullPath = [part.target, ...part.targets.slice(0, index + 1)]
            .map(candidate => candidate.$refText).join('.');
        const description = this.getUnsegmentedScope(context, referenceType).getElement(fullPath);
        return description ? [{ ...description, name: reference.$refText }] : [];
    }

    private getInvocationPathSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const references = isFlowElement(context.container) || isMethodInvocation(context.container)
            ? context.container.targets
            : [];
        const index = context.index ?? 0;
        if (index >= references.length) {
            return [];
        }
        const path = references.map(reference => reference.$refText);
        const description = this.getUnsegmentedScope(context, referenceType).getElement(path.join('.'));
        const target = description?.node ? this.getPathSegmentTarget(description.node, path, index, context) : undefined;
        return target
            ? [this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))]
            : [];
    }

    private getPathSegmentTarget(target: AstNode, path: string[], segmentIndex: number, context: ReferenceInfo): AstNode | undefined {
        const ancestors: AstNode[] = [];
        let current: AstNode | undefined = target;
        while (current) {
            if (isBoundedContextPart(current) && current.context.ref) {
                ancestors.push(current.context.ref);
            } else if (this.nameProvider.getName(current)) {
                ancestors.push(current);
            }
            current = current.$container;
        }

        let nextAncestor = 0;
        let selected: AstNode | undefined;
        for (let index = path.length - 1; index >= 0; index--) {
            const found = ancestors.findIndex((candidate, ancestorIndex) =>
                ancestorIndex >= nextAncestor && (
                    this.nameProvider.getName(candidate) === path[index] ||
                    this.isImportedComponentAlias(candidate, path[index], context)
                )
            );
            if (found < 0) {
                return undefined;
            }
            if (index === segmentIndex) {
                selected = ancestors[found];
            }
            nextAncestor = found + 1;
        }
        return selected;
    }

    private isImportedComponentAlias(node: AstNode, alias: string, context: ReferenceInfo): boolean {
        if (!isImportableComponent(node)) {
            return false;
        }
        const root = AstUtils.getDocument(context.container).parseResult.value;
        if (!isModel(root)) {
            return false;
        }
        const document = AstUtils.getDocument(context.container);
        for (const importDeclaration of root.imports) {
            if (importDeclaration.components.some(component =>
                component.alias === alias && component.component.ref === node
            )) {
                return true;
            }
            if (importDeclaration.alias !== alias) {
                continue;
            }
            if (UriUtils.equals(AstUtils.getDocument(node).uri, resolveImportUri(document, importDeclaration))) {
                return true;
            }
        }
        return false;
    }

    private addShapeFields(
        descriptions: AstNodeDescription[],
        shape: DataObject | ReadModel | import('./generated/ast.js').ValueObject,
        prefix: string,
        referenceType: string,
        visited: Set<AstNode>
    ): void {
        if (visited.has(shape)) {
            return;
        }
        visited.add(shape);
        for (const field of shape.fields) {
            const name = `${prefix}.${field.name}`;
            this.addSpecificationSymbol(descriptions, field, name, referenceType);
            const nested = field.type?.ref;
            if (nested && (isDataObject(nested) || isReadModel(nested) || isValueObject(nested))) {
                this.addShapeFields(descriptions, nested, name, referenceType, visited);
            }
        }
    }

    private addSpecificationSymbol(
        descriptions: AstNodeDescription[],
        node: AstNode,
        name: string,
        referenceType: string
    ): void {
        if (this.reflection.isSubtype(node.$type, referenceType)) {
            descriptions.push(this.descriptions.createDescription(node, name, AstUtils.getDocument(node)));
        }
    }

    private getModuleSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const module = getOwningModule(context.container);
        if (!module) {
            return [];
        }

        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        for (const dependency of module.dependencies) {
            const targetModule = dependency.ref;
            if (!targetModule) {
                continue;
            }
            for (const exposure of targetModule.exposures) {
                for (const declaration of exposure.declarations) {
                    const target = declaration.ref;
                    if (!target) {
                        continue;
                    }
                    if (this.reflection.isSubtype(target.$type, referenceType)) {
                        const name = this.nameProvider.getName(target);
                        if (name) {
                            this.addScopeCandidate(candidates, this.descriptions.createDescription(target, name), name);
                        }
                        const exportedName = getExportedName(target as AstNode & { name: string });
                        this.addScopeCandidate(candidates, this.descriptions.createDescription(target, exportedName), exportedName);
                    }
                    if ((isEntity(target) || isValueObject(target) || isDomainEvent(target) || isIntegrationEvent(target) || isReadModel(target) || isDataObject(target)) &&
                        this.reflection.isSubtype('Field', referenceType)) {
                        for (const field of target.fields) {
                            const fieldName = getExportedName(field);
                            for (const name of this.getUnaliasedNames(fieldName)) {
                                this.addScopeCandidate(candidates, this.descriptions.createDescription(field, name), name);
                            }
                        }
                    }
                }
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    private getImportedSymbols(document: LangiumDocument, referenceType: string): AstNodeDescription[] {
        const root = document.parseResult.value;
        if (!isModel(root) || root.imports.length === 0) {
            return [];
        }

        const importsByUri = new Map<string, Import[]>();
        for (const importDeclaration of root.imports) {
            const uri = resolveImportUri(document, importDeclaration).toString();
            const imports = importsByUri.get(uri) ?? [];
            imports.push(importDeclaration);
            importsByUri.set(uri, imports);
        }

        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        for (const description of this.indexManager.allElements(referenceType, new Set(importsByUri.keys()))) {
            const imports = importsByUri.get(description.documentUri.toString()) ?? [];
            for (const importDeclaration of imports) {
                if (importDeclaration.components.length > 0) {
                    for (const component of importDeclaration.components) {
                        const target = component.component.ref;
                        if (!target || !this.isWithinComponent(description.name, target)) {
                            continue;
                        }
                        const names = component.alias
                            ? this.getComponentAliasNames(description.name, getExportedName(target), component.alias)
                            : this.getUnaliasedNames(description.name);
                        this.addScopeCandidates(candidates, description, names);
                    }
                } else if (importDeclaration.alias) {
                    const targetName = this.getSingleImportableComponentName(document, importDeclaration);
                    if (targetName && this.isWithinComponentName(description.name, targetName)) {
                        this.addScopeCandidates(candidates, description,
                            this.getComponentAliasNames(description.name, targetName, importDeclaration.alias));
                    }
                } else {
                    this.addScopeCandidates(candidates, description, this.getUnaliasedNames(description.name));
                }
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    private getDocumentSymbols(context: ReferenceInfo, document: LangiumDocument, referenceType: string): AstNodeDescription[] {
        const descriptions = this.indexManager.allElements(referenceType, new Set([document.uri.toString()]));
        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        const owningContextName = this.getLexicalContextName(context);
        for (const description of descriptions) {
            this.addScopeCandidate(candidates, description, description.name);
            // Suffix aliases are useful within one context, but must not make a
            // declaration in another context compete for the same short name.
            const belongsToContext = owningContextName && description.name.startsWith(`${owningContextName}.`);
            const belongsToSharedKernel = description.node !== undefined && isInSharedKernel(description.node);
            if (belongsToContext || belongsToSharedKernel) {
                for (const name of this.getUnaliasedNames(description.name).slice(1)) {
                    this.addScopeCandidate(candidates, description, name);
                }
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    private getLexicalContextName(context: ReferenceInfo): string | undefined {
        let current: AstNode | undefined = context.container;
        while (current) {
            if (isBoundedContext(current)) {
                return current.name;
            }
            if (isBoundedContextPart(current)) {
                // Avoid resolving the very reference whose scope is being built.
                if (context.container === current && context.property === 'context') {
                    return undefined;
                }
                return current.context.ref?.name ?? current.context.$refText;
            }
            current = current.$container;
        }
        return undefined;
    }

    private getImportableComponents(component: import('./generated/ast.js').ImportComponent, referenceType: string): AstNodeDescription[] {
        const importDeclaration = component.$container;
        const document = AstUtils.getDocument(importDeclaration);
        const uri = resolveImportUri(document, importDeclaration).toString();
        return this.indexManager.allElements(referenceType, new Set([uri]))
            .filter(description => ['BoundedContext', 'ContextMap', 'SharedKernel'].includes(description.type))
            .toArray();
    }

    private getSingleImportableComponentName(document: LangiumDocument, importDeclaration: Import): string | undefined {
        const uri = resolveImportUri(document, importDeclaration).toString();
        const candidates = this.indexManager.allElements(undefined, new Set([uri]))
            .filter(description => ['BoundedContext', 'ContextMap', 'SharedKernel'].includes(description.type))
            .toArray();
        return candidates.length === 1 ? candidates[0].name : undefined;
    }

    private isWithinComponent(name: string, component: import('./generated/ast.js').ImportableComponent): boolean {
        const componentName = getExportedName(component as AstNode & { name: string });
        return this.isWithinComponentName(name, componentName);
    }

    private isWithinComponentName(name: string, componentName: string): boolean {
        return name === componentName || name.startsWith(`${componentName}.`);
    }

    private getComponentAliasNames(name: string, componentName: string, alias: string): string[] {
        if (name === componentName) {
            return [alias];
        }
        return [`${alias}.${name.slice(componentName.length + 1)}`];
    }

    private addScopeCandidates(
        candidates: Map<string, Map<string, AstNodeDescription>>,
        description: AstNodeDescription,
        names: string[]
    ): void {
        for (const name of names) {
            this.addScopeCandidate(candidates, description, name);
        }
    }

    private addScopeCandidate(
        candidates: Map<string, Map<string, AstNodeDescription>>,
        description: AstNodeDescription,
        name: string
    ): void {
        const symbolKey = `${description.documentUri.toString()}#${description.path}`;
        const matches = candidates.get(name) ?? new Map<string, AstNodeDescription>();
        matches.set(symbolKey, description);
        candidates.set(name, matches);
    }

    private getUniqueScopeCandidates(candidates: Map<string, Map<string, AstNodeDescription>>): AstNodeDescription[] {
        const unique: AstNodeDescription[] = [];
        for (const [name, matches] of candidates) {
            if (matches.size === 1) {
                unique.push({ ...matches.values().next().value!, name });
            }
        }
        return unique;
    }

    private getUnaliasedNames(name: string): string[] {
        const parts = name.split('.');
        return parts.map((_part, index) => parts.slice(index).join('.'));
    }

}
