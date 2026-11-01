import type { LangiumDocument } from 'langium';
import { DefaultRenameProvider } from 'langium/lsp';
import type { CancellationToken } from 'vscode-jsonrpc';
import type {
    Range,
    RenameParams,
    TextDocumentPositionParams,
    WorkspaceEdit
} from 'vscode-languageserver';

/**
 * Rename is disabled for the alpha. A future implementation must validate the
 * new name, quote reserved words and names with spaces/hyphens, reject
 * collisions, and update specification references before this provider is
 * enabled again.
 */
export class ThinaiRenameProvider extends DefaultRenameProvider {
    override async rename(
        _document: LangiumDocument,
        _params: RenameParams,
        _cancelToken?: CancellationToken
    ): Promise<WorkspaceEdit | undefined> {
        return undefined;
    }

    override async prepareRename(
        _document: LangiumDocument,
        _params: TextDocumentPositionParams,
        _cancelToken?: CancellationToken
    ): Promise<Range | undefined> {
        return undefined;
    }
}
