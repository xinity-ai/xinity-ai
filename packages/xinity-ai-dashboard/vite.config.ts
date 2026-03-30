import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { dependencies, devDependencies } from "./package.json";

/**
 * Workaround for @better-auth/sso importing `createAuthorizationURL` (and
 * other oauth2 helpers) from "better-auth" root, which doesn't re-export them.
 * They live in "better-auth/oauth2". This plugin rewrites the import at build
 * time. Track upstream: https://github.com/better-auth/better-auth/issues
 */
function betterAuthOAuth2Fix(): Plugin {
	// Only names that exist in "better-auth/oauth2" but NOT in "better-auth" root.
	// State helpers (generateState, parseState, etc.) are in the root, leave them.
	const OAUTH2_ONLY_NAMES = [
		'createAuthorizationURL',
		'validateAuthorizationCode',
		'validateToken',
		'refreshAccessToken',
	];

	return {
		name: 'better-auth-oauth2-fix',
		enforce: 'pre',
		transform(code, id) {
			if (!id.includes('@better-auth/sso')) return;
			// Match: import { ..., createAuthorizationURL, ... } from "better-auth"
			const re = /import\s*\{([^}]+)\}\s*from\s*["']better-auth["']/g;
			let transformed = false;

			const result = code.replace(re, (match, specifiers: string) => {
				const names = specifiers.split(',').map((s: string) => s.trim());
				const oauth2 = names.filter((n: string) => OAUTH2_ONLY_NAMES.includes(n.split(' as ')[0].trim()));
				const rest = names.filter((n: string) => !OAUTH2_ONLY_NAMES.includes(n.split(' as ')[0].trim()));

				if (oauth2.length === 0) return match;
				transformed = true;

				const parts: string[] = [];
				if (rest.length > 0) {
					parts.push(`import { ${rest.join(', ')} } from "better-auth"`);
				}
				parts.push(`import { ${oauth2.join(', ')} } from "better-auth/oauth2"`);
				return parts.join(';\n');
			});

			if (!transformed) return;
			return { code: result, map: null };
		},
	};
}

export default defineConfig({
	plugins: [
		betterAuthOAuth2Fix(),
		tailwindcss(),
		sveltekit(),
		devtoolsJson()
	],
	server: {
		warmup: {
			ssrFiles: [
				'src/hooks.server.ts',
				'src/lib/server/**/*.ts',
				'src/routes/**/+layout.server.ts',
				'src/routes/**/+page.server.ts',
			],
			clientFiles: [
				'src/routes/**/+layout.svelte',
				'src/routes/(authenticated)/+page.svelte',
				'src/lib/components/ui/**/*.svelte',
			],
		},
	},
	ssr: {
		external: Object.keys(dependencies),
		noExternal: Object.keys(devDependencies),
	}
});
