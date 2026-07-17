if (typeof globalThis.TextDecoder === "undefined") {
	// biome-ignore lint/suspicious/noExplicitAny: polyfill
	(globalThis as any).TextDecoder = class TextDecoder {
		decode(arr?: Uint8Array) {
			if (!arr) return "";
			// biome-ignore lint/suspicious/noExplicitAny: polyfill
			return String.fromCharCode.apply(null, arr as any);
		}
	};
}
