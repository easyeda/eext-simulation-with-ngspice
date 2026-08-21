import path from 'node:path';
import fs from 'fs-extra';
import ignore from 'ignore';
import JSZip from 'jszip';

import * as extensionConfig from '../extension.json';

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.resolve(__dirname, 'dist');

function lines(value: string): string[] {
	return value.split(/[\r\n]+/).filter((line) => line.trim() && !line.trim().startsWith('#'));
}

function validateRuntimeAssets(files: string[]) {
	const required = [
		'dist/index.js',
		'dist/iframe.js',
		'dist/iframe-styles.css',
		'iframe/index.html',
		'iframe/wasm/ngspice.js',
		'iframe/wasm/ngspice.wasm',
	];
	const fileSet = new Set(files);
	const missing = required.filter((file) => !fileSet.has(file));
	if (missing.length) throw new Error(`Package is missing runtime assets: ${missing.join(', ')}`);

	const iframeHtml = fs.readFileSync(path.join(rootDir, 'iframe/index.html'), 'utf-8');
	const iframeResourcePaths = [...iframeHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
	const nonPackagePaths = iframeResourcePaths.filter((resourcePath) => !resourcePath.startsWith('/'));
	if (nonPackagePaths.length) {
		throw new Error(`iframe/index.html must use package-root resource paths: ${nonPackagePaths.join(', ')}`);
	}
	const parameterizedPaths = iframeResourcePaths.filter((resourcePath) => /[?#]/.test(resourcePath));
	if (parameterizedPaths.length) {
		throw new Error(
			`iframe/index.html must not add query or fragment suffixes to package resources: ${parameterizedPaths.join(', ')}`,
		);
	}
	const missingReferencedAssets = iframeResourcePaths
		.map((resourcePath) => resourcePath.slice(1))
		.filter((resourcePath) => !fileSet.has(resourcePath));
	if (missingReferencedAssets.length) {
		throw new Error(
			`iframe/index.html references files not present in the extension package: ${missingReferencedAssets.join(', ')}`,
		);
	}

	const css = fs.readFileSync(path.join(rootDir, 'dist/iframe-styles.css'), 'utf-8');
	if (/\@import\b/i.test(css)) throw new Error('Bundled iframe CSS must not contain nested @import rules');
	for (const selector of ['.eda-app', '.workbench', '.chart-card', '.bottom-panel']) {
		if (!css.includes(selector)) throw new Error(`Bundled iframe CSS is missing core selector: ${selector}`);
	}
}

function main() {
	fs.ensureDirSync(outputDir);
	const rawFiles = fs.readdirSync(rootDir, { encoding: 'utf-8', recursive: true });
	const rules = lines(fs.readFileSync(path.join(rootDir, '.edaignore'), 'utf-8')).map((rule) => {
		return rule.endsWith('/') || rule.endsWith('\\') ? rule.slice(0, -1) : rule;
	});
	const filter = ignore().add(rules);
	const files = filter.filter(rawFiles)
		.map((file) => file.replace(/\\/g, '/'))
		.filter((file) => fs.lstatSync(path.join(rootDir, file)).isFile());
	validateRuntimeAssets(files);

	const zip = new JSZip();
	for (const file of files) {
		zip.file(file, fs.readFileSync(path.join(rootDir, file)));
	}

	const target = path.join(outputDir, `${extensionConfig.name}_v${extensionConfig.version}.eext`);
	zip.generateNodeStream({
		type: 'nodebuffer',
		streamFiles: true,
		compression: 'DEFLATE',
		compressionOptions: { level: 9 },
	}).pipe(fs.createWriteStream(target));
}

main();
