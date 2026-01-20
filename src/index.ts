export function activate(status?: 'onStartupFinished', arg?: string): void {
	// eslint-disable-next-line no-console
	console.log('Extension activated with status:', status, 'and arg:', arg);
	switch (status) {
		case 'onStartupFinished':
			// 将初始化代码放在这里
			break;
	}
}
