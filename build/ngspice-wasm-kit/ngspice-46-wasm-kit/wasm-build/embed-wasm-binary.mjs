import fs from 'node:fs';
import path from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
	console.error('Usage: node wasm-build/embed-wasm-binary.mjs <ngspice.wasm> <ngspice-wasm-binary.js>');
	process.exit(1);
}

const wasm = fs.readFileSync(inputPath);
const base64 = wasm.toString('base64');
const chunkSize = 64 * 1024;
const chunks = [];

for (let index = 0; index < base64.length; index += chunkSize) {
	chunks.push(base64.slice(index, index + chunkSize));
}

const body = `(function () {
  var chunks = [
${chunks.map((chunk) => `    '${chunk}'`).join(',\n')}
  ];
  globalThis.__JLC_NGSPICE_WASM_BASE64 = chunks;
  if (typeof window !== 'undefined') {
    window.__JLC_NGSPICE_WASM_BASE64 = chunks;
  }
})();
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, body);

console.log(`Embedded ${wasm.length} bytes from ${inputPath}`);
console.log(`Wrote ${chunks.length} base64 chunks to ${outputPath}`);

