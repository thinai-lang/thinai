/**
 * Identifier lexing shared by editor features. The grammar's `ID` terminal
 * accepts either a plain identifier or a backtick-delimited name that may
 * contain spaces and hyphens.
 */
export const THINAI_IDENTIFIER_SOURCE = '(?:[_a-zA-Z][\\w_]*|`[a-zA-Z0-9_ -]+`)';

/** A dotted path of identifiers, including backtick-delimited segments. */
export const THINAI_QUALIFIED_IDENTIFIER_SOURCE =
    `${THINAI_IDENTIFIER_SOURCE}(?:\\.${THINAI_IDENTIFIER_SOURCE})*`;

/** Removes backtick delimiters from a possibly partial identifier or path. */
export function normalizeIdentifierText(text: string): string {
    return text.replace(/`/gu, '');
}

/** Removes the surrounding backticks from one identifier segment. */
export function unquoteIdentifier(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('`')) {
        return trimmed;
    }
    const withoutStart = trimmed.slice(1);
    return withoutStart.endsWith('`') ? withoutStart.slice(0, -1) : withoutStart;
}

/** Removes surrounding backticks from every segment of a dotted identifier. */
export function unquoteQualifiedName(text: string): string {
    return text.split('.').map(segment => unquoteIdentifier(segment)).join('.');
}

/**
 * Characters that may occur inside an identifier. Langium uses this to decide
 * whether a cursor sits directly after a name, so backticks, spaces, and
 * hyphens from backtick-delimited names must be included.
 */
export const THINAI_NAME_CHARACTER_REGEXP = /^[\w\p{L}` -]$/u;
