import { AstUtils, isReference, type AstNode, type LangiumDocument, type ReferenceInfo } from 'langium';
import { DefaultDefinitionProvider } from 'langium/lsp';
import { LocationLink, type DefinitionParams } from 'vscode-languageserver';
import { isImportableComponent, isModel } from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import { resolveImportUri } from './thinai-scope.js';

/**
 * Uses Langium's normal reference navigation for segmented paths. The fallback
 * handles legacy references whose grammar still stores a dotted path as one
 * cross-reference.
 */
export class ThinaiDefinitionProvider extends DefaultDefinitionProvider {
    constructor(services: ThinaiServices) {
        super(services);
    }

    override getDefinition(document: LangiumDocument, params: DefinitionParams) {
        const root = document.parseResult.value;
        const offset = document.textDocument.offsetAt(params.position);
        const referenceInfo = AstUtils.streamAst(root).toArray()
            .flatMap(node => AstUtils.streamReferences(node).toArray())
            .find(info => this.isDottedReferenceAt(info, offset));

        if (!referenceInfo || !isReference(referenceInfo.reference) || !referenceInfo.reference.ref || !referenceInfo.reference.$refNode) {
            return super.getDefinition(document, params);
        }

        const parts = referenceInfo.reference.$refText.split('.');
        const relativeOffset = offset - referenceInfo.reference.$refNode.offset;
        let segmentOffset = 0;
        let clickedSegment = -1;
        for (let index = 0; index < parts.length; index++) {
            const segmentEnd = segmentOffset + parts[index].length;
            if (segmentOffset <= relativeOffset && relativeOffset < segmentEnd) {
                clickedSegment = index;
                break;
            }
            // Match Langium's cursor behavior on punctuation: a dot is
            // associated with the preceding identifier, not underlined itself.
            if (relativeOffset === segmentEnd && index + 1 < parts.length) {
                clickedSegment = index;
                break;
            }
            segmentOffset = segmentEnd + 1;
        }
        if (clickedSegment < 0 && relativeOffset === referenceInfo.reference.$refText.length) {
            clickedSegment = parts.length - 1;
        }
        if (clickedSegment < 0) {
            return super.getDefinition(document, params);
        }

        const selected = this.findPathSegmentTarget(referenceInfo.reference.ref, parts, clickedSegment, document);
        const nameNode = selected ? this.nameProvider.getNameNode(selected) : undefined;
        const targetCstNode = selected?.$cstNode;
        if (!selected || !nameNode || !targetCstNode) {
            return super.getDefinition(document, params);
        }

        const segmentStart = referenceInfo.reference.$refNode.offset + this.getSegmentOffset(parts, clickedSegment);
        const originRange = {
            start: document.textDocument.positionAt(segmentStart),
            end: document.textDocument.positionAt(segmentStart + parts[clickedSegment].length)
        };
        const targetDocument = AstUtils.getDocument(selected);
        return [LocationLink.create(targetDocument.textDocument.uri, targetCstNode.range, nameNode.range, originRange)];
    }

    private isDottedReferenceAt(info: ReferenceInfo, offset: number): boolean {
        const reference = info.reference;
        return isReference(reference) && reference.$refText.includes('.') && reference.$refNode !== undefined &&
            reference.$refNode.offset <= offset && offset < reference.$refNode.end;
    }

    private findPathSegmentTarget(
        target: AstNode,
        path: string[],
        segmentIndex: number,
        sourceDocument: LangiumDocument
    ): AstNode | undefined {
        const ancestors: AstNode[] = [];
        let current: AstNode | undefined = target;
        while (current) {
            if (this.nameProvider.getName(current)) {
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
                    this.isImportedComponentAlias(candidate, path[index], sourceDocument)
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

    private isImportedComponentAlias(node: AstNode, alias: string, sourceDocument: LangiumDocument): boolean {
        if (!isImportableComponent(node)) {
            return false;
        }
        const model = sourceDocument.parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        for (const importDeclaration of model.imports) {
            if (importDeclaration.components.some(component => component.alias === alias && component.component.ref === node)) {
                return true;
            }
            if (importDeclaration.alias === alias && AstUtils.getDocument(node).uri.toString() ===
                resolveImportUri(sourceDocument, importDeclaration).toString()) {
                return true;
            }
        }
        return false;
    }

    private getSegmentOffset(path: string[], index: number): number {
        return path.slice(0, index).reduce((offset, segment) => offset + segment.length + 1, 0);
    }
}
