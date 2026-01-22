import type esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const rawPlugin: esbuild.Plugin = {
	name: 'raw-loader',
	setup(build) {
		build.onResolve({ filter: /\?raw$/ }, (args) => {
			const realPath = args.path.replace(/\?raw$/, '');
			return {
				path: path.isAbsolute(realPath) ? realPath : path.join(args.resolveDir, realPath),
				namespace: 'raw-file',
			};
		});
		build.onLoad({ filter: /.*/, namespace: 'raw-file' }, async (args) => {
			const contents = await fs.readFile(args.path, 'utf8');
			return { contents, loader: 'text' };
		});
	},
};

export default {
	entryPoints: {
		index: './src/index',
	},
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // 用于内部方法调用，请勿修改
	minify: false, // 用于内部方法调用，请勿修改
	outdir: './dist/',
	sourcemap: undefined,
	platform: 'browser', // 用于内部方法调用，请勿修改
	format: 'iife', // 用于内部方法调用，请勿修改
	globalName: 'edaEsbuildExportName', // 用于内部方法调用，请勿修改
	treeShaking: true,
	ignoreAnnotations: true,
	define: {},
	external: [],
	plugins: [rawPlugin],
	loader: {
		'.wasm': 'base64',
		'.txt': 'text',
		'.net': 'text',
	},
} satisfies Parameters<(typeof esbuild)['build']>[0];
