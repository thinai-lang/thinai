# Thinai for VS Code

<p><img src="./icons/thinai-light.svg" alt="Thinai logo" width="80"></p>

The Thinai VS Code extension adds language support for `.tni` domain models,
including completion, navigation, diagnostics, formatting, and import quick
fixes. This guide covers running the extension from this repository.

## Try the extension

1. Open the repository root in VS Code.
2. Run `npm install` if dependencies are not installed yet.
3. Run `npm run build` from the repository root.
4. Press `F5` to launch the Extension Development Host.
5. Open an `.tni` file, such as one in
   [the Order Fulfillment example](../../examples/order-fulfillment/README.md).

## Develop the extension

- [package.json](./package.json) — extension metadata, language registration,
  and editor defaults.
- [src/language/main.ts](./src/language/main.ts) — language-server entry point.
- [src/extension/main.ts](./src/extension/main.ts) — starts the language client
  and server.
- [language-configuration.json](./language-configuration.json) — comments and
  bracket configuration.
- [esbuild.mjs](./esbuild.mjs) — extension bundle configuration.

The extension uses [Langium](https://langium.org/) for language services. To
debug the extension-host runtime with the inspector enabled on port `9230`, run
this from the workspace root:

```bash
code --inspect-extensions=9230 --extensionDevelopmentPath="$PWD/packages/extension" "$PWD"
```

See the [Langium documentation](https://langium.org/) for framework-specific
background.
