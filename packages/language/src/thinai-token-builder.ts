import { createToken, type TokenType, type TokenVocabulary } from 'chevrotain';
import { DefaultTokenBuilder, type Grammar, type TokenBuilderOptions } from 'langium';

const DOUBLE_STRING_MODE = 'THINAI_DOUBLE_STRING';
const SINGLE_STRING_MODE = 'THINAI_SINGLE_STRING';
const REFERENCE_MODE = 'THINAI_REFERENCE';

export class ThinaiTokenBuilder extends DefaultTokenBuilder {
    override buildTokens(grammar: Grammar, options?: TokenBuilderOptions): TokenVocabulary {
        const vocabulary = super.buildTokens(grammar, options);
        if (!Array.isArray(vocabulary)) {
            return vocabulary;
        }

        const token = (name: string): TokenType => {
            const result = vocabulary.find(candidate => candidate.name === name);
            if (!result) {
                throw new Error(`Thinai lexer is missing the '${name}' token.`);
            }
            return result;
        };
        const createVariant = (
            source: TokenType,
            action: { push_mode?: string; pop_mode?: boolean; line_breaks?: boolean } = {}
        ): TokenType => {
            const config: Parameters<typeof createToken>[0] = {
                name: source.name,
                pattern: source.PATTERN!,
                line_breaks: action.line_breaks ?? source.LINE_BREAKS
            };
            if (source.GROUP !== undefined) {
                config.group = source.GROUP;
            }
            if (action.push_mode !== undefined) {
                config.push_mode = action.push_mode;
            }
            if (action.pop_mode !== undefined) {
                config.pop_mode = action.pop_mode;
            }
            return createToken(config);
        };

        const doubleOpen = token('TEMPLATE_STRING_START');
        const doubleClose = token('TEMPLATE_STRING_END');
        const singleOpen = token('SINGLE_TEMPLATE_STRING_START');
        const singleClose = token('SINGLE_TEMPLATE_STRING_END');
        const doubleStringText = token('DOUBLE_STRING_TEXT');
        const singleStringText = token('SINGLE_STRING_TEXT');
        const interpolationStart = token('${');
        const interpolationEnd = token('INTERPOLATION_END');
        const id = token('ID');
        const whitespace = token('WS');
        const dot = token('.');

        const internalNames = new Set([
            doubleClose.name,
            singleClose.name,
            doubleStringText.name,
            singleStringText.name,
            interpolationStart.name,
            interpolationEnd.name
        ]);
        const defaultSources = vocabulary.filter(candidate => !internalNames.has(candidate.name));
        const defaultSourceSet = new Set(defaultSources);
        const defaultMap = new Map<TokenType, TokenType>();
        for (const source of defaultSources) {
            const action = source.name === doubleOpen.name
                ? { push_mode: DOUBLE_STRING_MODE }
                : source.name === singleOpen.name
                    ? { push_mode: SINGLE_STRING_MODE }
                    : {};
            defaultMap.set(source, createVariant(source, action));
        }
        for (const source of defaultSources) {
            const longerAlt = source.LONGER_ALT;
            if (!longerAlt) {
                continue;
            }
            const alternatives = (Array.isArray(longerAlt) ? longerAlt : [longerAlt])
                .filter(candidate => defaultSourceSet.has(candidate))
                .map(candidate => defaultMap.get(candidate)!);
            const target = defaultMap.get(source)!;
            if (alternatives.length > 0) {
                target.LONGER_ALT = alternatives;
            }
        }
        const defaultMode = defaultSources.map(source => defaultMap.get(source)!);

        const interpolationStartInString = createVariant(interpolationStart, { push_mode: REFERENCE_MODE });
        const doubleStringTextToken = createVariant(doubleStringText, { line_breaks: true });
        const singleStringTextToken = createVariant(singleStringText, { line_breaks: true });
        const doubleStringMode = [
            doubleStringTextToken,
            createVariant(doubleClose, { pop_mode: true }),
            interpolationStartInString
        ];
        const singleStringMode = [
            singleStringTextToken,
            createVariant(singleClose, { pop_mode: true }),
            interpolationStartInString
        ];
        const referenceMode = [
            defaultMap.get(id)!,
            defaultMap.get(dot)!,
            defaultMap.get(whitespace)!,
            createVariant(interpolationEnd, { pop_mode: true })
        ];

        return {
            modes: {
                DEFAULT_MODE: defaultMode,
                [DOUBLE_STRING_MODE]: doubleStringMode,
                [SINGLE_STRING_MODE]: singleStringMode,
                [REFERENCE_MODE]: referenceMode
            },
            defaultMode: 'DEFAULT_MODE'
        };
    }
}
