import { defineConfig } from "vite";

export default defineConfig({
	server: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	build: {
		rolldownOptions: {
			// Suppress `Module "node:module" has been externalized for browser compatibility`
			onLog(level, log, defaultHandler) {
				if (log.message?.includes("node:module")) return;
				defaultHandler(level, log);
			},
		},
	},
});
