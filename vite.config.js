import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // Chemins relatifs : la même construction sert au site et à l'application de bureau (file://)
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    rolldownOptions: {
      output: {
        // Bibliothèques à part : mieux mises en cache, le code de l'appli se télécharge seul quand il change
        advancedChunks: { groups: [{ name: 'vendor', test: /node_modules/ }] },
      },
    },
  },
});
