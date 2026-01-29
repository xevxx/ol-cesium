import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/bundle.ts',
  output: {
    file: 'dist-bundle/ol-cesium.js',
    format: 'esm',
    sourcemap: false
  },
  external: [
    'cesium',
    'ol'
  ],
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.bundle.json'
    })
  ]
};
