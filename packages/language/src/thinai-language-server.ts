import { DefaultLanguageServer } from 'langium/lsp';
import type { InitializeParams, InitializeResult } from 'vscode-languageserver';

/**
 * Thinai intentionally does not expose rename during the alpha. Remove the
 * capability from the initialize result so editors do not advertise an
 * operation whose new-name validation and quoting rules are not implemented.
 */
export class ThinaiLanguageServer extends DefaultLanguageServer {
    protected override buildInitializeResult(params: InitializeParams): InitializeResult {
        const result = super.buildInitializeResult(params);
        delete (result.capabilities as { renameProvider?: unknown }).renameProvider;
        return result;
    }
}
