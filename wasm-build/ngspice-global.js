(function () {
	var factory = null;

	if (typeof createNgspiceModule === 'function') {
		factory = createNgspiceModule;
	}

	if (!factory && typeof module === 'object' && module && typeof module.exports === 'function') {
		factory = module.exports;
	}

	if (!factory && typeof module === 'object' && module && module.exports && typeof module.exports.default === 'function') {
		factory = module.exports.default;
	}

	if (!factory && typeof exports === 'function') {
		factory = exports;
	}

	if (!factory && typeof exports === 'object' && exports && typeof exports.default === 'function') {
		factory = exports.default;
	}

	if (factory) {
		globalThis.createNgspiceModule = factory;
		if (typeof window !== 'undefined') {
			window.createNgspiceModule = factory;
		}
	}
})();
