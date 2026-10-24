import adapter from '@eslym/sveltekit-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	compilerOptions: {
		experimental: {
			async: true,
		},
	},

	kit: {
		adapter: adapter({ bundler: 'bun' }),
		version: { name: pkg.version },
		alias: {
			"common-db": "../common-db/src/",
			"common-env": "../common-env/src/",
			"common-log": "../common-log/src/"
		},
    paths: {
      base: "",
    },
		experimental: {
			remoteFunctions: true
		},
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// Pinned to the exact file /api loads, so nothing else on the CDN can run.
				'script-src': ['self', 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.73.1/dist/browser/standalone.min.js'],
				// Svelte transitions and the API reference set inline styles.
				'style-src': ['self', 'unsafe-inline'],
				// Organization logos are arbitrary URLs.
				'img-src': ['self', 'data:', 'https:'],
				'font-src': ['self', 'data:'],
				'connect-src': ['self'],
				'frame-ancestors': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
			},
		},
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		// adapter: adapter()
	}
};

export default config;
