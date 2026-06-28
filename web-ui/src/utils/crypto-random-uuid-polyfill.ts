// `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost).
// When Kanban is served over plain HTTP on a remote host (e.g.
// http://my-host:3484), it is undefined and any unguarded call crashes the UI
// (notably the link-tasks action). `crypto.getRandomValues` IS available in
// insecure contexts, so we polyfill a RFC 4122 v4 UUID from it. Imported first
// in main.tsx, before any code that may call crypto.randomUUID.
function installCryptoRandomUuidPolyfill(): void {
	const cryptoObj = globalThis.crypto as Crypto | undefined;
	if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
		return;
	}
	if (typeof cryptoObj.randomUUID === "function") {
		return;
	}

	const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
		const rand = new Uint8Array(16);
		cryptoObj.getRandomValues(rand);
		// Set the version (4) and variant (10xx) bits per RFC 4122.
		const hex = Array.from(rand, (byte, index) => {
			let value = byte;
			if (index === 6) {
				value = (byte & 0x0f) | 0x40;
			} else if (index === 8) {
				value = (byte & 0x3f) | 0x80;
			}
			return value.toString(16).padStart(2, "0");
		}).join("");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as `${string}-${string}-${string}-${string}-${string}`;
	};

	try {
		Object.defineProperty(cryptoObj, "randomUUID", {
			value: randomUUID,
			configurable: true,
			writable: true,
		});
	} catch {
		// Some environments expose a read-only crypto; ignore if we can't patch.
	}
}

installCryptoRandomUuidPolyfill();
