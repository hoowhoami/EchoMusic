export function getErrorMessage(e: unknown): string {
	if (e instanceof Error) {
		return e.message;
	}

	if (typeof e === "string") {
		return e;
	}

	if (e != null && typeof e === "object") {
		if ("message" in e && typeof e.message === "string") {
			return e.message;
		}

		try {
			return JSON.stringify(e);
		} catch {
			return String(e);
		}
	}

	return String(e);
}
