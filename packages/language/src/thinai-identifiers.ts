/**
 * Identifier lexing shared by editor features. The grammar's `ID` terminal
 * accepts either a plain identifier or a backtick-delimited name that may
 * contain spaces and hyphens.
 */
export const THINAI_IDENTIFIER_SOURCE = '(?:[_a-zA-Z][\\w_]*|`[a-zA-Z0-9_ -]+`)';

/** A dotted path of identifiers, including backtick-delimited segments. */
export const THINAI_QUALIFIED_IDENTIFIER_SOURCE =
    `${THINAI_IDENTIFIER_SOURCE}(?:\\.${THINAI_IDENTIFIER_SOURCE})*`;

/**
 * Characters that may occur inside an identifier. Langium uses this to decide
 * whether a cursor sits directly after a name, so backticks, spaces, and
 * hyphens from backtick-delimited names must be included.
 */
export const THINAI_NAME_CHARACTER_REGEXP = /^[\w\p{L}` -]$/u;
