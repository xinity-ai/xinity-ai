import adapter from '@eslym/sveltekit-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({ bundler: 'bun' }),
		version: { name: pkg.version },
		alias: {
			"common-db": "../common-db/src/",
			"common-env": "../common-env/src/",
			"common-log": "../common-log/src/",
			"xinity-infoserver": "../xinity-infoserver/"
		},
    paths: {
      base: "",
    },
		experimental: {
			remoteFunctions: true
		},
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		// adapter: adapter()
	}
};

export default config;
