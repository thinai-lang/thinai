/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://vitest.dev/config/
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: {
        alias: {
            'thinai-language': fileURLToPath(new URL('./src/index.ts', import.meta.url))
        }
    },
    test: {
        deps: {
            interopDefault: true
        },
        include: ['**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/generated/**'],
            reporter: ['text', 'text-summary', 'html'],
            reportsDirectory: './coverage'
        }
    }
});
