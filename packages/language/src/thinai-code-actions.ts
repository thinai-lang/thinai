import {
    AstUtils,
    GrammarUtils,
    type AstNode,
    type LangiumDocument,
    type ReferenceInfo,
    UriUtils,
    isReference
} from 'langium';
import {
    CodeActionKind,
    type CodeAction,
    type CodeActionParams,
    type TextEdit
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import {
    isAggregate,
    isApplicationService,
    isBoundedContext,
    isBoundedContextPart,
    isDataObject,
    isDomainEvent,
    isDomainService,
    isEntity,
    isEnumType,
    isEnumValue,
    isFactory,
    isField,
    isImportableComponent,
    isIntegrationEvent,
    isMethod,
    isModel,
    isModule,
    isParameter,
    isProjector,
    isQueryRepository,
    isQueryService,
    isReadModel,
    isRepository,
    isSharedKernel,
    isValueObject,
    type BoundedContext,
    type BoundedContextPart,
    type Import,
    type ImportableComponent,
    type Module
} from './generated/ast.js';
import {
    formatIdentifier,
    formatQualifiedName,
    getDeclarationPath,
    getOwningAggregate,
    getOwningContextName,
    getOwningModule,
    isExposedByModule,
    isModuleAccessibleFromContext,
    isModulePubliclyVisible,
    resolveAstNodeDescription,
    resolveImportUri,
    toImportPath
} from './thinai-scope-utils.js';
import { ThinaiScopeProvider } from './thinai-scope-provider.js';
import { getLineStartOffset, getNewline } from './thinai-text-utils.js';
import { importPathRange } from './thinai-document-link-provider.js';
import { inferIndentationOptions } from './thinai-indentation.js';

interface UnresolvedReference {
    name: string;
    info: ReferenceInfo;
}

interface ImportCandidate {
    importPath: string;
    existingImport?: Import;
    component?: ImportableComponent;
}

export class ThinaiCodeActionProvider {
    constructor(private readonly services: ThinaiServices) {}

    getCodeActions(
        document: LangiumDocument,
        params: CodeActionParams,
        _cancelToken?: CancellationToken
    ): CodeAction[] {
        const actions: CodeAction[] = [];
        for (const diagnostic of params.context.diagnostics) {
            const partRootActions = this.getPartRootCodeActions(document, diagnostic);
            if (partRootActions.length > 0) {
                actions.push(...partRootActions);
                continue;
            }
            const partImportAction = this.getPartImportCodeAction(document, diagnostic);
            if (partImportAction) {
                actions.push(partImportAction);
                continue;
            }
            const multilineStringAction = this.getMultilineStringCodeAction(document, diagnostic);
            if (multilineStringAction) {
                actions.push(multilineStringAction);
                continue;
            }
            const unresolved = this.getUnresolvedReference(document, diagnostic.range);
            if (!unresolved) {
                actions.push(...this.getVisibilityCodeActions(document, diagnostic));
                continue;
            }

            const candidates = this.findImportCandidates(document, unresolved);
            for (const candidate of candidates) {
                const { importPath, existingImport, component } = candidate;
                const title = `Import '${unresolved.name}' from '${importPath}'`;
                const textDocument = document.textDocument;
                let range;
                let newText: string;
                if (existingImport && component) {
                    const closingBrace = existingImport.$cstNode && GrammarUtils.findNodesForKeyword(existingImport.$cstNode, '}')[0];
                    if (!closingBrace) {
                        continue;
                    }
                    range = {
                        start: textDocument.positionAt(closingBrace.offset),
                        end: textDocument.positionAt(closingBrace.offset)
                    };
                    newText = `, ${formatIdentifier(component.name)}`;
                } else {
                    const newline = getNewline(textDocument.getText());
                    range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                    newText = component
                        ? `import { ${formatIdentifier(component.name)} } from "${importPath}"${newline}`
                        : `import "${importPath}"${newline}`;
                }
                actions.push({
                    title,
                    kind: CodeActionKind.QuickFix,
                    isPreferred: candidates.length === 1,
                    diagnostics: [diagnostic],
                    edit: {
                        changes: {
                            [document.uri.toString()]: [
                                { range, newText }
                            ]
                        }
                    }
                });
            }
        }

        actions.push(...this.getCreatePartCodeActions(document, params.range));
        return actions;
    }

    private getPartRootCodeActions(
        document: LangiumDocument,
        diagnostic: CodeActionParams['context']['diagnostics'][number]
    ): CodeAction[] {
        if (diagnostic.code !== 'part-without-root') {
            return [];
        }
        const part = this.getPartAtRange(document, diagnostic.range);
        const contextName = part?.context?.ref?.name ?? part?.context?.$refText;
        if (!part || !contextName) {
            return [];
        }
        const unitIndex = this.services.modelUnit.ThinaiModelUnitIndex;
        const roots = unitIndex.getRootsDeclaringContext(contextName)
            .filter(root => !UriUtils.equals(root.uri, document.uri))
            .filter(root => !this.importsDocument(root, document.uri))
            .sort((left, right) => left.uri.toString().localeCompare(right.uri.toString()));
        if (roots.length === 0) {
            return [this.getCreateRootCodeAction(document, diagnostic, contextName)];
        }
        const actions: CodeAction[] = [];
        for (const root of roots) {
            const rootPath = toImportPath(UriUtils.dirname(document.uri), root.uri);
            const partPath = toImportPath(UriUtils.dirname(root.uri), document.uri);
            const edit = this.appendImport(root, partPath);
            if (!edit) {
                continue;
            }
            actions.push({
                title: `Add this part to '${rootPath}'`,
                kind: CodeActionKind.QuickFix,
                isPreferred: roots.length === 1,
                diagnostics: [diagnostic],
                edit: { changes: { [root.uri.toString()]: [edit] } }
            });
        }
        return actions;
    }

    private getCreateRootCodeAction(
        document: LangiumDocument,
        diagnostic: CodeActionParams['context']['diagnostics'][number],
        contextName: string
    ): CodeAction {
        return {
            title: `Create a bounded-context root for '${contextName}'…`,
            kind: CodeActionKind.QuickFix,
            isPreferred: true,
            diagnostics: [diagnostic],
            command: {
                title: 'Create bounded-context root',
                command: 'thinai.createRoot',
                arguments: [{
                    uri: document.uri.toString(),
                    contextName
                }]
            }
        };
    }

    private getCreatePartCodeActions(
        document: LangiumDocument,
        range: CodeActionParams['range']
    ): CodeAction[] {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return [];
        }
        const start = document.textDocument.offsetAt(range.start);
        const context = AstUtils.streamAst(model)
            .filter(isBoundedContext)
            .find(candidate => candidate.$cstNode !== undefined &&
                candidate.$cstNode.offset <= start && start <= candidate.$cstNode.end) as BoundedContext | undefined;
        if (!context) {
            return [];
        }
        return [{
            title: `Create a bounded-context part of '${context.name}'…`,
            kind: CodeActionKind.Refactor,
            command: {
                title: 'Create bounded-context part',
                command: 'thinai.createPart',
                arguments: [{
                    uri: document.uri.toString(),
                    contextName: context.name
                }]
            }
        }];
    }

    private getPartImportCodeAction(
        document: LangiumDocument,
        diagnostic: CodeActionParams['context']['diagnostics'][number]
    ): CodeAction | undefined {
        if (diagnostic.code !== 'import-part-directly') {
            return undefined;
        }
        const importDeclaration = this.getImportAtRange(document, diagnostic.range);
        if (!importDeclaration) {
            return undefined;
        }
        const targetUri = resolveImportUri(document, importDeclaration);
        const target = targetUri
            ? this.services.shared.workspace.LangiumDocuments.getDocument(targetUri)
            : undefined;
        if (!target) {
            return undefined;
        }
        const root = this.services.modelUnit.ThinaiModelUnitIndex.getRootForDocument(target);
        if (!root || UriUtils.equals(root.uri, document.uri)) {
            return undefined;
        }
        const importPath = toImportPath(UriUtils.dirname(document.uri), root.uri);
        if (importPath === importDeclaration.path) {
            return undefined;
        }
        const pathNode = importDeclaration.$cstNode &&
            GrammarUtils.findNodeForProperty(importDeclaration.$cstNode, 'path');
        if (!pathNode) {
            return undefined;
        }
        return {
            title: `Import '${importPath}' instead`,
            kind: CodeActionKind.QuickFix,
            isPreferred: true,
            diagnostics: [diagnostic],
            edit: {
                changes: {
                    [document.uri.toString()]: [{
                        range: importPathRange(document, pathNode),
                        newText: importPath
                    }]
                }
            }
        };
    }

    private getPartAtRange(
        document: LangiumDocument,
        range: CodeActionParams['context']['diagnostics'][number]['range']
    ): BoundedContextPart | undefined {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const start = document.textDocument.offsetAt(range.start);
        const end = document.textDocument.offsetAt(range.end);
        for (const node of AstUtils.streamAst(model)) {
            if (isBoundedContextPart(node) && node.$cstNode &&
                node.$cstNode.offset <= start && end <= node.$cstNode.end) {
                return node;
            }
        }
        return undefined;
    }

    private getImportAtRange(
        document: LangiumDocument,
        range: CodeActionParams['context']['diagnostics'][number]['range']
    ): Import | undefined {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const start = document.textDocument.offsetAt(range.start);
        const end = document.textDocument.offsetAt(range.end);
        return model.imports.find(importDeclaration =>
            importDeclaration.$cstNode !== undefined &&
            importDeclaration.$cstNode.offset <= start &&
            end <= importDeclaration.$cstNode.end
        );
    }

    private importsDocument(root: LangiumDocument, target: import('langium').URI): boolean {
        const model = root.parseResult.value;
        return isModel(model) && model.imports.some(importDeclaration => {
            const uri = resolveImportUri(root, importDeclaration);
            return uri !== undefined && UriUtils.equals(uri, target);
        });
    }

    private appendImport(root: LangiumDocument, importPath: string): TextEdit | undefined {
        const model = root.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const newline = getNewline(root.textDocument.getText());
        const lastImport = model.imports.at(-1);
        if (lastImport?.$cstNode) {
            const position = root.textDocument.positionAt(lastImport.$cstNode.end);
            return {
                range: { start: position, end: position },
                newText: `${newline}import "${importPath}"`
            };
        }
        return {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: `import "${importPath}"${newline}`
        };
    }

    private getMultilineStringCodeAction(
        document: LangiumDocument,
        diagnostic: CodeActionParams['context']['diagnostics'][number]
    ): CodeAction | undefined {
        if (diagnostic.code !== 'multiline-string-requires-triple-quotes') {
            return undefined;
        }
        const text = document.textDocument.getText(diagnostic.range);
        const quote = text[0];
        if ((quote !== '"' && quote !== "'") || text.at(-1) !== quote) {
            return undefined;
        }
        const content = text.slice(1, -1);
        if (content.includes('"""')) {
            return undefined;
        }
        const body = /^\r?\n/u.test(content) ? content : `\n${content}`;
        const formattedBody = /\r?\n[ \t]*$/u.test(body) ? body : `${body}\n`;
        return {
            title: 'Use triple double quotes',
            kind: CodeActionKind.QuickFix,
            isPreferred: true,
            diagnostics: [diagnostic],
            edit: {
                changes: {
                    [document.uri.toString()]: [{
                        range: diagnostic.range,
                        newText: `"""${formattedBody}"""`
                    }]
                }
            }
        };
    }

    private getVisibilityCodeActions(
        document: LangiumDocument,
        diagnostic: CodeActionParams['context']['diagnostics'][number]
    ): CodeAction[] {
        const message = String(diagnostic.message);
        if (!/(?:module reference requires a dependency|outside a module may reference|specification path segment is not visible)/u
            .test(message)) {
            return [];
        }
        const referenceInfo = this.getResolvedReferenceAtRange(document, diagnostic.range);
        const target = referenceInfo && isReference(referenceInfo.reference)
            ? referenceInfo.reference.ref
            : undefined;
        if (!referenceInfo || !target) {
            return [];
        }
        const targetModule = getOwningModule(target);
        if (!targetModule || !isModuleAccessibleFromContext(targetModule) ||
            AstUtils.getDocument(targetModule) !== document) {
            return [];
        }
        const sourceModule = getOwningModule(referenceInfo.container);
        if (sourceModule && AstUtils.getDocument(sourceModule) !== document) {
            return [];
        }
        const sourceContext = getOwningContextName(referenceInfo.container);
        const targetContext = getOwningContextName(targetModule);
        if (sourceContext !== undefined && targetContext !== undefined && sourceContext !== targetContext) {
            return [];
        }

        const edits: TextEdit[] = [];
        let dependencyPath: string | undefined;
        let exposurePath: string | undefined;
        if (sourceModule && sourceModule !== targetModule &&
            !isModulePubliclyVisible(sourceModule, targetModule)) {
            const modulePath = getModulePath(targetModule);
            if (modulePath.length > 0) {
                dependencyPath = formatQualifiedName(modulePath.join('.'));
                const edit = this.appendDependency(document, sourceModule, dependencyPath);
                if (edit) {
                    edits.push(edit);
                }
            }
        }
        if (!isExposedByModule(targetModule, target)) {
            const exposureTarget = getExposureTarget(target);
            const path = exposureTarget ? getExposurePath(targetModule, exposureTarget) : undefined;
            if (path) {
                exposurePath = formatQualifiedName(path);
                const edit = this.appendExposure(document, targetModule, exposurePath);
                if (edit) {
                    edits.push(edit);
                }
            }
        }

        if (edits.length === 0) {
            return [];
        }
        const title = dependencyPath && exposurePath
            ? `Make '${exposurePath}' visible from module '${sourceModule!.name}'`
            : exposurePath
                ? `Expose '${exposurePath}' in module '${targetModule.name}'`
                : `Add 'depends on ${dependencyPath}' to module '${sourceModule!.name}'`;
        return [{
            title,
            kind: CodeActionKind.QuickFix,
            isPreferred: true,
            diagnostics: [diagnostic],
            edit: { changes: { [document.uri.toString()]: edits } }
        }];
    }

    private appendDependency(document: LangiumDocument, module: Module, path: string): TextEdit | undefined {
        const last = module.dependencyClauses.at(-1);
        if (last?.$cstNode) {
            const position = document.textDocument.positionAt(last.$cstNode.end);
            return { range: { start: position, end: position }, newText: `, ${path}` };
        }
        return this.insertModuleClause(document, module, `depends on ${path}`);
    }

    private appendExposure(document: LangiumDocument, module: Module, path: string): TextEdit | undefined {
        const lastExposure = module.exposures.at(-1);
        const lastDeclaration = lastExposure?.declarations.at(-1);
        if (lastDeclaration?.$cstNode) {
            const position = document.textDocument.positionAt(lastDeclaration.$cstNode.end);
            return { range: { start: position, end: position }, newText: `, ${path}` };
        }
        return this.insertModuleClause(document, module, `exposes ${path}`);
    }

    private insertModuleClause(document: LangiumDocument, module: Module, clause: string): TextEdit | undefined {
        const cstNode = module.$cstNode;
        const openingBrace = cstNode && GrammarUtils.findNodesForKeyword(cstNode, '{')[0];
        if (!openingBrace) {
            return undefined;
        }
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, cstNode.offset);
        const lineIndent = /^[\t ]*/u.exec(text.slice(lineStart, cstNode.offset))?.[0] ?? '';
        const indentation = inferIndentationOptions(text);
        const unit = indentation.insertSpaces ? ' '.repeat(indentation.tabSize) : '\t';
        const position = document.textDocument.positionAt(openingBrace.end);
        return {
            range: { start: position, end: position },
            newText: `${getNewline(text)}${lineIndent}${unit}${clause}`
        };
    }

    private getResolvedReferenceAtRange(
        document: LangiumDocument,
        range: CodeActionParams['context']['diagnostics'][number]['range']
    ): ReferenceInfo | undefined {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const start = document.textDocument.offsetAt(range.start);
        const end = document.textDocument.offsetAt(range.end);
        for (const node of AstUtils.streamAst(model)) {
            for (const referenceInfo of AstUtils.streamReferences(node)) {
                const reference = referenceInfo.reference;
                const referenceNode = reference.$refNode;
                if (isReference(reference) && reference.ref && referenceNode &&
                    referenceNode.offset <= end && start <= referenceNode.end) {
                    return referenceInfo;
                }
            }
        }
        return undefined;
    }

    private getUnresolvedReference(
        document: LangiumDocument,
        range: CodeActionParams['context']['diagnostics'][number]['range']
    ): UnresolvedReference | undefined {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const start = document.textDocument.offsetAt(range.start);
        const end = document.textDocument.offsetAt(range.end);
        for (const node of AstUtils.streamAst(model)) {
            for (const referenceInfo of AstUtils.streamReferences(node)) {
                const reference = referenceInfo.reference;
                const referenceNode = reference.$refNode;
                if (isReference(reference) && !reference.ref && referenceNode &&
                    referenceNode.offset <= start && end <= referenceNode.end) {
                    return reference.$refText ? { name: reference.$refText, info: referenceInfo } : undefined;
                }
            }
        }
        return undefined;
    }

    private findImportCandidates(document: LangiumDocument, unresolved: UnresolvedReference): ImportCandidate[] {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return [];
        }

        const importsByUri = new Map<string, Import[]>();
        for (const importDeclaration of model.imports) {
            const uri = resolveImportUri(document, importDeclaration);
            if (uri) {
                const imports = importsByUri.get(uri.toString()) ?? [];
                imports.push(importDeclaration);
                importsByUri.set(uri.toString(), imports);
            }
        }
        const scopeProvider = this.services.references.ScopeProvider as ThinaiScopeProvider;
        const reflection = this.services.shared.AstReflection;
        const targetType = reflection.getReferenceType(unresolved.info);
        const candidates = new Map<string, ImportCandidate>();
        for (const description of this.services.shared.workspace.IndexManager.allElements()) {
            if (UriUtils.equals(description.documentUri, document.uri) ||
                description.name !== unresolved.name && !description.name.endsWith(`.${unresolved.name}`) ||
                !reflection.isSubtype(description.type, targetType)) {
                continue;
            }
            const targetNode = resolveAstNodeDescription(description, this.services);
            const visibleAfterImport = scopeProvider
                .filterCompletionCandidates(unresolved.info, [description])
                .toArray().length > 0;
            // Cross-context types remain private without an authorized
            // relationship, so do not offer an import that the language would
            // reject. Unowned strategic declarations (actors, subdomains) and
            // similar non-type targets are importable.
            if (!visibleAfterImport && reflection.isSubtype(description.type, 'TypeDeclaration')) {
                continue;
            }

            const uriKey = description.documentUri.toString();
            const existingImport = importsByUri.get(uriKey)?.find(importDeclaration => importDeclaration.components.length > 0);
            const importPath = toImportPath(UriUtils.dirname(document.uri), description.documentUri);
            const component = this.getImportableComponent(targetNode);
            if (importsByUri.has(uriKey)) {
                if (!existingImport) {
                    continue;
                }
                if (!component) {
                    // Unowned strategic declarations (actors, subdomains,
                    // journeys) and members whose owning component cannot be
                    // inferred are still visible through a bare import. A bare
                    // import is valid alongside selective imports.
                    candidates.set(uriKey, { importPath });
                    continue;
                }
                if (existingImport.components.some(selection => selection.component.ref === component)) {
                    continue;
                }
                const key = `${uriKey}#${component.$cstNode?.offset ?? component.name}`;
                candidates.set(key, { importPath, existingImport, component });
            } else if (component && this.countImportableComponents(description.documentUri) > 1) {
                // Files that declare several components must be imported
                // selectively; a bare import would expose every sibling.
                const key = `${uriKey}#${component.$cstNode?.offset ?? component.name}`;
                candidates.set(key, { importPath, component });
            } else {
                candidates.set(uriKey, { importPath });
            }
        }
        return [...candidates.values()];
    }

    private countImportableComponents(uri: import('langium').URI): number {
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(uri);
        const model = document?.parseResult.value;
        return isModel(model)
            ? model.declarations.filter(isImportableComponent).length
            : 0;
    }

    private getImportableComponent(node: import('langium').AstNode | undefined): ImportableComponent | undefined {
        if (!node) {
            return undefined;
        }
        const ancestor = AstUtils.getContainerOfType(node, isImportableComponent);
        if (ancestor) {
            return ancestor;
        }
        // Members of a contribution block have no canonical `BoundedContext`
        // ancestor. Infer the component from the owning context name and the
        // target document's declarations instead.
        const contextName = getOwningContextName(node);
        if (!contextName) {
            return undefined;
        }
        const model = AstUtils.getDocument(node).parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const declaration = model.declarations.find(candidate =>
            (isBoundedContext(candidate) || isSharedKernel(candidate)) && candidate.name === contextName
        );
        return isBoundedContext(declaration) || isSharedKernel(declaration) ? declaration : undefined;
    }
}

function getModulePath(module: Module): string[] {
    const path: string[] = [];
    let current: AstNode | undefined = module;
    while (current) {
        if (isModule(current)) {
            path.unshift(current.name);
        }
        if (isBoundedContext(current) || isBoundedContextPart(current) || isSharedKernel(current)) {
            break;
        }
        current = current.$container;
    }
    return path;
}

function getExposureTarget(target: AstNode): AstNode | undefined {
    if (isField(target) || isParameter(target)) {
        return getExposureTarget(target.$container);
    }
    if (isEnumValue(target)) {
        return target.$container;
    }
    if (isMethod(target)) {
        return getExposureTarget(target.$container);
    }
    if (isEntity(target)) {
        const aggregate = getOwningAggregate(target);
        return target.root && aggregate ? aggregate : target;
    }
    if (isAggregate(target) || isModule(target) || isValueObject(target) || isDataObject(target) ||
        isReadModel(target) || isEnumType(target) || isDomainEvent(target) || isIntegrationEvent(target) ||
        isApplicationService(target) || isDomainService(target) || isQueryService(target) ||
        isProjector(target) || isFactory(target) || isRepository(target) || isQueryRepository(target)) {
        return target;
    }
    return undefined;
}

function getExposurePath(module: Module, target: AstNode): string | undefined {
    if (!('name' in target) || typeof target.name !== 'string') {
        return undefined;
    }
    const targetPath = getDeclarationPath(target as AstNode & { name: string });
    const modulePath = getModulePath(module);
    if (modulePath.length > targetPath.length ||
        modulePath.some((segment, index) => targetPath[index] !== segment)) {
        return undefined;
    }
    const relative = targetPath.slice(modulePath.length);
    return relative.length > 0 ? relative.join('.') : undefined;
}
