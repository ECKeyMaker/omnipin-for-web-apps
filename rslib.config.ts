import { defineConfig } from '@rslib/core'

const minify = {
  js: true,
  jsOptions: {
    minimizerOptions: {
      minify: false,
      mangle: false,
      compress: {
        module: true,
        dead_code: true,
        toplevel: true,
        evaluate: true,
        computed_props: true,
        drop_debugger: true,
        unused: true,
        side_effects: true,
        arrows: true,
        ecma: '2022',
        keep_fargs: false,
        keep_fnames: false,
        pure_getters: true,
        reduce_funcs: true,
        hoist_funs: true,
        hoist_props: true,
      },
    },
  },
} as const

export default defineConfig({
  source: { tsconfigPath: './tsconfig.build.json' },
  lib: [
    // Runtime-neutral library for browsers and Cloudflare Workers.
    {
      id: 'core',
      format: 'esm',
      bundle: true,
      autoExternal: false,
      dts: true,
      experiments: { advancedEsm: true },
      source: { entry: { index: './src/index.ts' } },
      output: {
        target: 'web',
        minify,
        legalComments: 'none',
        cleanDistPath: false,
      },
    },
    // Node CLI.
    {
      id: 'cli',
      format: 'esm',
      bundle: true,
      autoExternal: false,
      experiments: { advancedEsm: true },
      source: { entry: { cli: './src/cli.ts' } },
      output: {
        target: 'node',
        minify,
        legalComments: 'none',
        cleanDistPath: false,
      },
    },
  ],
})
