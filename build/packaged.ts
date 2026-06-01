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
