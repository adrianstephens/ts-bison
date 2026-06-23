import eslint from "@eslint/js";
import tslint from "typescript-eslint";
import { dirname } from 'path';
import { fileURLToPath } from 'url';
async function maybeImport(modulePath) { try { return await import(modulePath); } catch { return undefined; } }
let customPlugin = await maybeImport('../eslint-custom.mjs');
// @ts-check

export default tslint.config(
	eslint.configs.recommended,
	...tslint.configs.recommended,
	...tslint.configs.stylistic,
	...(customPlugin ? [customPlugin.config] : []),
	{
		rules: {
			"semi": ["error", "always"],
			"no-cond-assign": "off",
			//"@typescript-eslint/no-misleading-character-class": "off",
			//"@typescript-eslint/no-this-alias": "off",
			"@typescript-eslint/prefer-function-type": "off",
			"@typescript-eslint/array-type": "off",
			"@typescript-eslint/no-unused-vars":  [
				"warn", {
					argsIgnorePattern: "^(_+$|_[^_])",
					varsIgnorePattern: "^(_+$|_[^_])",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "off",
			//"@typescript-eslint/explicit-module-boundary-types": "off",
			//"@typescript-eslint/no-non-null-assertion": "off"
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/consistent-indexed-object-style": "off"

		},
	},
	{
		// Type-aware linting for the actual package source (matches tsconfig.json's
		// rootDir/include).
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: dirname(fileURLToPath(import.meta.url))
			}
		}
	},
	{
		// Everything else (test/, hidden/, etc.) isn't part of tsconfig.json's
		// program, so just parse it -- no `project`, so no type-aware rules, but
		// also no ambiguous tsconfigRootDir auto-detection across sibling packages.
		files: ["**/*.ts"],
		ignores: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				tsconfigRootDir: dirname(fileURLToPath(import.meta.url))
			}
		}
	}
);
