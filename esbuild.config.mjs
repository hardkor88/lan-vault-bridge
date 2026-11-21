import esbuild from 'esbuild';

const banner = `/*
LAN Vault Bridge — bidirectional vault sync over the local network.
Bundled from TypeScript into a single CJS file. Node.js modules (http, os) are
loaded lazily on desktop via window.require and are never required on mobile.
*/
`;

const production = process.argv[2] === 'production';

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ['src/main.ts'],
	bundle: true,
	// Obsidian и Electron предоставляют эти модули в рантайме, бандлить их нельзя.
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', '@electron/*'],
	format: 'cjs',
	target: 'es2018',
	platform: 'browser',
	logLevel: 'info',
	sourcemap: production ? false : 'inline',
	treeShaking: true,
	minify: production,
	legalComments: 'none',
	define: {
		global: 'globalThis',
	},
	outfile: 'main.js',
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
