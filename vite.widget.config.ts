import { defineConfig } from 'vite'

// Production build for the headless WxCC↔Oracle bridge. Outputs a single
// classic (non-module) script — dist-widget/wxcc-oracle-bridge.js — that
// WxCC Desktop's "agentx-custom-desktop" widget loader injects directly
// into its own document via a plain <script src>. No React/JSX here: the
// bridge renders nothing, so this build has no plugin-react dependency
// and no CSS/code-splitting concerns.
export default defineConfig({
  build: {
    outDir: 'dist-widget',
    emptyOutDir: true,
    lib: {
      entry: 'src/bridge.ts',
      name: 'WxccOracleBridge',
      formats: ['iife'],
      fileName: () => 'wxcc-oracle-bridge.js',
    },
  },
})
