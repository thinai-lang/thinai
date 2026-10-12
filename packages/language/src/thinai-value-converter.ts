import { DefaultValueConverter } from 'langium';

export class ThinaiValueConverter extends DefaultValueConverter {
    protected override runConverter(
        rule: Parameters<DefaultValueConverter['runConverter']>[0],
        input: string,
        cstNode: Parameters<DefaultValueConverter['runConverter']>[2]
    ): ReturnType<DefaultValueConverter['runConverter']> {
        if (rule.name === 'TRIPLE_DOUBLE_STRING_START' || rule.name === 'TRIPLE_DOUBLE_STRING_END'
            || rule.name === 'DOUBLE_STRING_START' || rule.name === 'DOUBLE_STRING_END'
            || rule.name === 'SINGLE_STRING_START' || rule.name === 'SINGLE_STRING_END') {
            return '';
        }
        if (rule.name === 'TRIPLE_DOUBLE_STRING_TEXT' || rule.name === 'DOUBLE_STRING_TEXT'
            || rule.name === 'SINGLE_STRING_TEXT') {
            return this.convertText(input);
        }
        return super.runConverter(rule, input, cstNode);
    }

    private convertText(input: string): string {
        let result = '';
        for (let index = 0; index < input.length; index++) {
            const character = input[index];
            if (character !== '\\' || index + 1 >= input.length) {
                result += character;
                continue;
            }

            const escaped = input[++index];
            switch (escaped) {
                case 'b': result += '\b'; break;
                case 'f': result += '\f'; break;
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                case 'v': result += '\v'; break;
                case '0': result += '\0'; break;
                default: result += escaped;
            }
        }
        return result;
    }
}
