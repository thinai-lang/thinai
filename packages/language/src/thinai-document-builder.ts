import { DefaultDocumentBuilder, type LangiumDocument } from 'langium';
import { isModel } from './generated/ast.js';
import { resolveImportUri } from './thinai-scope-utils.js';

export class ThinaiDocumentBuilder extends DefaultDocumentBuilder {
    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        if (super.shouldRelink(document, changedUris)) {
            return true;
        }

        const model = document.parseResult.value;
        return isModel(model) && model.imports.some(importDeclaration => {
            const uri = resolveImportUri(document, importDeclaration);
            return uri !== undefined && changedUris.has(uri.toString());
        });
    }
}
