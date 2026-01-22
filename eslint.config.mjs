import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,

	rules: {
		'no-console': 'off',
		'no-eval': 'off',
		'node/prefer-global/buffer': 'off',
		'unused-imports/no-unused-vars': 'off',
	},

	ignores: ['build/dist/', 'coverage/', 'dist/', 'node_modules/', '.eslintcache', 'debug.log', 'wasm/'],
});
