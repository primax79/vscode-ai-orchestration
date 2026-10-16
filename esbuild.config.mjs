import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(extensionConfig);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(extensionConfig);
    console.log('[esbuild] build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
