import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess, { execFile as execFile$2 } from 'node:child_process';
import fs$1, { constants } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

let isDockerCached;

function hasDockerEnv() {
	try {
		fs.statSync('/.dockerenv');
		return true;
	} catch {
		return false;
	}
}

function hasDockerCGroup() {
	try {
		return fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
	} catch {
		return false;
	}
}

function isDocker() {
	// TODO: Use `??=` when targeting Node.js 16.
	if (isDockerCached === undefined) {
		isDockerCached = hasDockerEnv() || hasDockerCGroup();
	}

	return isDockerCached;
}

let cachedResult;

// Podman detection
const hasContainerEnv = () => {
	try {
		fs.statSync('/run/.containerenv');
		return true;
	} catch {
		return false;
	}
};

function isInsideContainer() {
	// TODO: Use `??=` when targeting Node.js 16.
	if (cachedResult === undefined) {
		cachedResult = hasContainerEnv() || isDocker();
	}

	return cachedResult;
}

const isWsl = () => {
	if (process.platform !== 'linux') {
		return false;
	}

	if (os.release().toLowerCase().includes('microsoft')) {
		if (isInsideContainer()) {
			return false;
		}

		return true;
	}

	try {
		if (fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')) {
			return !isInsideContainer();
		}
	} catch {}

	// Fallback for custom kernels: check WSL-specific paths.
	if (
		fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
		|| fs.existsSync('/run/WSL')
	) {
		return !isInsideContainer();
	}

	return false;
};

var isWsl$1 = process.env.__IS_WSL_TEST__ ? isWsl : isWsl();

const execFile$1 = promisify(childProcess.execFile);

const powerShellPath$1 = () => `${process.env.SYSTEMROOT || process.env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

const argumentsPrefix = [
	'-NoProfile',
	'-NonInteractive',
	'-ExecutionPolicy',
	'Bypass',
	'-EncodedCommand',
];

const encodeCommand = command => Buffer.from(command, 'utf16le').toString('base64');

/*
PowerShell's tokenizer treats the typographic single quotes U+2018, U+2019, U+201A, and U+201B as string delimiters, exactly like the ASCII one, and it does not require the closing quote to match the opening quote. Escaping only the ASCII quote would let any of the others terminate the string and inject a statement. Doubling works for all of them.
*/
const escapeArgument = value => `'${String(value).replaceAll(/['‘’‚‛]/g, match => match + match)}'`;

const createArguments = command => [...argumentsPrefix, encodeCommand(command)];

const createExecFileOptions = options => ({
	encoding: 'utf8',
	...options,
	shell: false,
});

const executePowerShell = async (command, options = {}) => {
	const {
		powerShellPath: psPath,
		...execFileOptions
	} = options;

	return execFile$1(
		psPath ?? powerShellPath$1(),
		createArguments(command),
		createExecFileOptions(execFileOptions),
	);
};

executePowerShell.argumentsPrefix = argumentsPrefix;
executePowerShell.encodeCommand = encodeCommand;
executePowerShell.escapeArgument = escapeArgument;
executePowerShell.createArguments = createArguments;

function parseMountPointFromConfig(content) {
	for (const line of content.split('\n')) {
		// Skip comment lines
		if (/^\s*#/.test(line)) {
			continue;
		}

		// Match root at start of line (after optional whitespace)
		const match = /^\s*root\s*=\s*(?<mountPoint>"[^"]*"|'[^']*'|[^#]*)/.exec(line);
		if (!match) {
			continue;
		}

		return match.groups.mountPoint
			.trim()
			// Strip surrounding quotes
			.replaceAll(/^["']|["']$/g, '');
	}
}

const execFile = promisify(childProcess.execFile);

const wslDrivesMountPoint = (() => {
	// Default value for "root" param
	// according to https://docs.microsoft.com/en-us/windows/wsl/wsl-config
	const defaultMountPoint = '/mnt/';

	let mountPoint;

	return async function () {
		if (mountPoint) {
			// Return memoized mount point value
			return mountPoint;
		}

		const configFilePath = '/etc/wsl.conf';

		let isConfigFileExists = false;
		try {
			await fs$1.access(configFilePath, constants.F_OK);
			isConfigFileExists = true;
		} catch {}

		if (!isConfigFileExists) {
			return defaultMountPoint;
		}

		const configContent = await fs$1.readFile(configFilePath, {encoding: 'utf8'});
		const parsedMountPoint = parseMountPointFromConfig(configContent);

		if (parsedMountPoint === undefined) {
			return defaultMountPoint;
		}

		mountPoint = parsedMountPoint;
		mountPoint = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;

		return mountPoint;
	};
})();

const powerShellPathFromWsl = async () => {
	const mountPoint = await wslDrivesMountPoint();
	return `${mountPoint}c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;
};

const powerShellPath = isWsl$1 ? powerShellPathFromWsl : powerShellPath$1;

// Cache for PowerShell accessibility check
let canAccessPowerShellPromise;

const canAccessPowerShell = async () => {
	canAccessPowerShellPromise ??= (async () => {
		try {
			const psPath = await powerShellPath();
			await fs$1.access(psPath, constants.X_OK);
			return true;
		} catch {
			// PowerShell is not accessible (either doesn't exist, no execute permission, or other error)
			return false;
		}
	})();

	return canAccessPowerShellPromise;
};

const wslDefaultBrowser = async () => {
	const psPath = await powerShellPath();
	const command = String.raw`(Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice").ProgId`;

	// The spawned Windows process inherits the Linux working directory, which WSL exposes to Windows as a `\\wsl.localhost\…` UNC path served by the distro's default user, so a directory that user cannot traverse makes the launch fail. PowerShell's own directory is on the Windows drive, so it always resolves to a plain `C:\…` path.
	const {stdout} = await executePowerShell(command, {
		powerShellPath: psPath,
		cwd: path.dirname(psPath),
	});

	return stdout.trim();
};

const isUrl = path => /^[a-z]+:\/\//i.test(path);

// `wslpath` only accepts a single path, so each path needs its own call.
const convertPath = async (flag, path) => {
	// `--` stops `wslpath` from reading a leading `-` as an option. Only pass it when needed, as it is only confirmed for WSL 2.5 and later.
	const wslpathArguments = path.startsWith('-') ? [flag, '--', path] : [flag, path];

	try {
		const {stdout} = await execFile('wslpath', wslpathArguments, {encoding: 'utf8'});
		return stdout.replace(/\r?\n$/, '') || path;
	} catch {
		// If wslpath fails, keep original path
		return path;
	}
};

const convertWslPathToWindows = async paths => {
	const isBatch = Array.isArray(paths);
	const pathArray = isBatch ? paths : [paths];
	// URLs stay as-is
	const results = await Promise.all(pathArray.map(path => isUrl(path) ? path : convertPath('-aw', path)));
	return isBatch ? results : results[0];
};

function defineLazyProperty(object, propertyName, valueGetter) {
	const define = value => Object.defineProperty(object, propertyName, {value, enumerable: true, writable: true});

	Object.defineProperty(object, propertyName, {
		configurable: true,
		enumerable: true,
		get() {
			const result = valueGetter();
			define(result);
			return result;
		},
		set(value) {
			define(value);
		}
	});

	return object;
}

const execFileAsync$3 = promisify(execFile$2);

async function defaultBrowserId() {
	if (process.platform !== 'darwin') {
		throw new Error('macOS only');
	}

	const {stdout} = await execFileAsync$3('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']);

	// `(?!-)` is to prevent matching `LSHandlerRoleAll = "-";`.
	const match = /LSHandlerRoleAll = "(?!-)(?<id>[^"]+?)";\s+?LSHandlerURLScheme = (?:http|https);/.exec(stdout);

	const browserId = match?.groups.id ?? 'com.apple.Safari';

	// Correct the case for Safari's bundle identifier
	if (browserId === 'com.apple.safari') {
		return 'com.apple.Safari';
	}

	return browserId;
}

const execFileAsync$2 = promisify(execFile$2);

async function runAppleScript(script, {humanReadableOutput = true, signal} = {}) {
	if (process.platform !== 'darwin') {
		throw new Error('macOS only');
	}

	const outputArguments = humanReadableOutput ? [] : ['-ss'];

	const execOptions = {};
	if (signal) {
		execOptions.signal = signal;
	}

	const {stdout} = await execFileAsync$2('osascript', ['-e', script, outputArguments], execOptions);
	return stdout.trim();
}

// Only a double quote can end the AppleScript string literal. A backslash can pre-escape one, and line breaks are rejected as defense in depth.
const bundleIdentifierPattern = /^[^\n\r"\\]+$/u;

async function bundleName(bundleId) {
	if (typeof bundleId !== 'string') {
		throw new TypeError('Expected a string bundle identifier');
	}

	if (!bundleIdentifierPattern.test(bundleId)) {
		throw new TypeError(`Invalid bundle identifier: ${JSON.stringify(bundleId)}`);
	}

	return runAppleScript(`tell application "Finder" to set app_path to application file id "${bundleId}" as string\ntell application "System Events" to get value of property list item "CFBundleName" of property list file (app_path & ":Contents:Info.plist")`);
}

const execFileAsync$1 = promisify(execFile$2);

// TODO: Fix the casing of bundle identifiers in the next major version.

// Windows doesn't have browser IDs in the same way macOS/Linux does so we give fake
// ones that look real and match the macOS/Linux versions for cross-platform apps.
const windowsBrowserProgIds = {
	MSEdgeHTM: {name: 'Edge', id: 'com.microsoft.edge'}, // The missing `L` is correct.
	MSEdgeBHTML: {name: 'Edge Beta', id: 'com.microsoft.edge.beta'},
	MSEdgeDHTML: {name: 'Edge Dev', id: 'com.microsoft.edge.dev'},
	AppXq0fevzme2pys62n3e0fbqa7peapykr8v: {name: 'Edge', id: 'com.microsoft.edge.old'},
	ChromeHTML: {name: 'Chrome', id: 'com.google.chrome'},
	ChromeBHTML: {name: 'Chrome Beta', id: 'com.google.chrome.beta'},
	ChromeDHTML: {name: 'Chrome Dev', id: 'com.google.chrome.dev'},
	ChromiumHTM: {name: 'Chromium', id: 'org.chromium.Chromium'},
	BraveHTML: {name: 'Brave', id: 'com.brave.Browser'},
	BraveBHTML: {name: 'Brave Beta', id: 'com.brave.Browser.beta'},
	BraveDHTML: {name: 'Brave Dev', id: 'com.brave.Browser.dev'},
	BraveSSHTM: {name: 'Brave Nightly', id: 'com.brave.Browser.nightly'},
	FirefoxURL: {name: 'Firefox', id: 'org.mozilla.firefox'},
	OperaStable: {name: 'Opera', id: 'com.operasoftware.Opera'},
	VivaldiHTM: {name: 'Vivaldi', id: 'com.vivaldi.Vivaldi'},
	'IE.HTTP': {name: 'Internet Explorer', id: 'com.microsoft.ie'},
};

const _windowsBrowserProgIdMap = new Map(Object.entries(windowsBrowserProgIds));

class UnknownBrowserError extends Error {}

async function defaultBrowser$1(_execFileAsync = execFileAsync$1) {
	const regPath = `${process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows'}\\System32\\reg.exe`;
	const {stdout} = await _execFileAsync(regPath, [
		'QUERY',
		' HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
		'/v',
		'ProgId',
	]);

	const match = /ProgId\s*REG_SZ\s*(?<id>\S+)/.exec(stdout);
	if (!match) {
		throw new UnknownBrowserError(`Cannot find Windows browser in stdout: ${JSON.stringify(stdout)}`);
	}

	const {id} = match.groups;

	// Windows can append a hash suffix to ProgIds using a dot or hyphen
	// (e.g., `ChromeHTML.ABC123`, `FirefoxURL-6F193CCC56814779`).
	// Try exact match first, then try without the suffix.
	const dotIndex = id.lastIndexOf('.');
	const hyphenIndex = id.lastIndexOf('-');
	const baseIdByDot = dotIndex === -1 ? undefined : id.slice(0, dotIndex);
	const baseIdByHyphen = hyphenIndex === -1 ? undefined : id.slice(0, hyphenIndex);

	return windowsBrowserProgIds[id] ?? windowsBrowserProgIds[baseIdByDot] ?? windowsBrowserProgIds[baseIdByHyphen] ?? {name: id, id};
}

const execFileAsync = promisify(execFile$2);

// Inlined: https://github.com/sindresorhus/titleize/blob/main/index.js
const titleize = string => string.toLowerCase().replaceAll(/(?:^|\s|-)\S/g, x => x.toUpperCase());

async function defaultBrowser() {
	if (process.platform === 'darwin') {
		const id = await defaultBrowserId();
		const name = await bundleName(id);
		return {name, id};
	}

	if (process.platform === 'linux') {
		const {stdout} = await execFileAsync('xdg-mime', ['query', 'default', 'x-scheme-handler/http']);
		const id = stdout.trim();
		const name = titleize(id.replace(/.desktop$/, '').replace('-', ' '));
		return {name, id};
	}

	if (process.platform === 'win32') {
		return defaultBrowser$1();
	}

	throw new Error('Only macOS, Linux, and Windows are supported');
}

const isInSsh = Boolean(process.env.SSH_CONNECTION
	|| process.env.SSH_CLIENT
	|| process.env.SSH_TTY);

const fallbackAttemptSymbol = Symbol('fallbackAttempt');

// Path to included `xdg-open`.
const __dirname$1 = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : '';
const localXdgOpenPath = path.join(__dirname$1, 'xdg-open');

const {platform, arch} = process;

const tryEachApp = async (apps, opener) => {
	if (apps.length === 0) {
		// No app was provided
		return;
	}

	const errors = [];

	for (const app of apps) {
		try {
			return await opener(app); // eslint-disable-line no-await-in-loop
		} catch (error) {
			errors.push(error);
		}
	}

	throw new AggregateError(errors, 'Failed to open in all supported apps');
};

// eslint-disable-next-line complexity
const baseOpen = async options => {
	options = {
		wait: false,
		background: false,
		newInstance: false,
		allowNonzeroExitCode: false,
		...options,
	};

	const isFallbackAttempt = options[fallbackAttemptSymbol] === true;
	delete options[fallbackAttemptSymbol];

	if (Array.isArray(options.app)) {
		return tryEachApp(options.app, singleApp => baseOpen({
			...options,
			app: singleApp,
			[fallbackAttemptSymbol]: true,
		}));
	}

	let {name: app, arguments: appArguments = []} = options.app ?? {};
	appArguments = [...appArguments];

	if (Array.isArray(app)) {
		return tryEachApp(app, appName => baseOpen({
			...options,
			app: {
				name: appName,
				arguments: appArguments,
			},
			[fallbackAttemptSymbol]: true,
		}));
	}

	if (app === 'browser' || app === 'browserPrivate') {
		// IDs from default-browser for macOS and windows are the same.
		// IDs are lowercased to increase chances of a match.
		const ids = {
			'com.google.chrome': 'chrome',
			'google-chrome.desktop': 'chrome',
			'com.brave.browser': 'brave',
			'org.mozilla.firefox': 'firefox',
			'firefox.desktop': 'firefox',
			'com.microsoft.msedge': 'edge',
			'com.microsoft.edge': 'edge',
			'com.microsoft.edgemac': 'edge',
			'microsoft-edge.desktop': 'edge',
			'com.apple.safari': 'safari',
		};

		// Incognito flags for each browser in `apps`.
		const flags = {
			chrome: '--incognito',
			brave: '--incognito',
			firefox: '--private-window',
			edge: '--inPrivate',
			// Safari doesn't support private mode via command line
		};

		let browser;
		if (isWsl$1) {
			const progId = await wslDefaultBrowser();
			const browserInfo = _windowsBrowserProgIdMap.get(progId);
			browser = browserInfo ?? {};
		} else {
			browser = await defaultBrowser();
		}

		const browserId = browser.id?.toLowerCase();
		if (Object.hasOwn(ids, browserId)) {
			const browserName = ids[browserId];

			if (app === 'browserPrivate') {
				// Safari doesn't support private mode via command line
				if (browserName === 'safari') {
					throw new Error('Safari doesn\'t support opening in private mode via command line');
				}

				appArguments.push(flags[browserName]);
			}

			return baseOpen({
				...options,
				app: {
					name: apps[browserName],
					arguments: appArguments,
				},
			});
		}

		throw new Error(`${browser.name} is not supported as a default browser`);
	}

	let command;
	const cliArguments = [];
	const childProcessOptions = {};

	// Determine if we should use Windows/PowerShell behavior in WSL.
	// We only use Windows integration if PowerShell is actually accessible.
	// This allows the package to work in sandboxed WSL environments where Windows access is restricted.
	let shouldUseWindowsInWsl = false;
	if (isWsl$1 && !isInsideContainer() && !isInSsh && !app) {
		shouldUseWindowsInWsl = await canAccessPowerShell();
	}

	if (platform === 'darwin') {
		command = 'open';

		if (options.wait) {
			cliArguments.push('--wait-apps');
		}

		if (options.background) {
			cliArguments.push('--background');
		}

		if (options.newInstance) {
			cliArguments.push('--new');
		}

		if (app) {
			cliArguments.push('-a', app);
		}
	} else if (platform === 'win32' || shouldUseWindowsInWsl) {
		command = await powerShellPath();

		cliArguments.push(...executePowerShell.argumentsPrefix);

		if (!isWsl$1) {
			childProcessOptions.windowsVerbatimArguments = true;
		}

		// Convert WSL Linux paths to Windows paths
		if (isWsl$1 && options.target) {
			options.target = await convertWslPathToWindows(options.target);
		}

		// Suppress PowerShell progress messages that are written to stderr
		const encodedArguments = ['$ProgressPreference = \'SilentlyContinue\';', 'Start'];

		if (options.wait) {
			encodedArguments.push('-Wait');
		}

		if (app) {
			encodedArguments.push(executePowerShell.escapeArgument(app));
			if (options.target) {
				appArguments.push(options.target);
			}
		} else if (options.target) {
			encodedArguments.push(executePowerShell.escapeArgument(options.target));
		}

		if (appArguments.length > 0) {
			appArguments = appArguments.map(argument => executePowerShell.escapeArgument(argument));
			encodedArguments.push('-ArgumentList', appArguments.join(','));
		}

		// Using Base64-encoded command, accepted by PowerShell, to allow special characters.
		options.target = executePowerShell.encodeCommand(encodedArguments.join(' '));

		if (!options.wait) {
			// PowerShell will keep the parent process alive unless stdio is ignored.
			childProcessOptions.stdio = 'ignore';
		}

		if (isWsl$1) {
			// The spawned Windows process inherits the Linux working directory, which WSL exposes to Windows as a `\\wsl.localhost\…` UNC path served by the distro's default user, so a directory that user cannot traverse makes the launch fail. PowerShell's own directory is on the Windows drive, so it always resolves to a plain `C:\…` path. Nothing here uses the working directory as the target is a URL or an absolute Windows path.
			childProcessOptions.cwd = path.dirname(command);
		}
	} else {
		if (app) {
			command = app;
		} else {
			// When bundled by Webpack, there's no actual package file path and no local `xdg-open`.
			const isBundled = !__dirname$1 || __dirname$1 === '/';

			// Check if local `xdg-open` exists and is executable.
			let exeLocalXdgOpen = false;
			try {
				await fs$1.access(localXdgOpenPath, constants.X_OK);
				exeLocalXdgOpen = true;
			} catch {}

			const useSystemXdgOpen = process.versions.electron
				?? (platform === 'android' || isBundled || !exeLocalXdgOpen);
			command = useSystemXdgOpen ? 'xdg-open' : localXdgOpenPath;
		}

		if (appArguments.length > 0) {
			cliArguments.push(...appArguments);
		}

		if (!options.wait) {
			// `xdg-open` will block the process unless stdio is ignored
			// and it's detached from the parent even if it's unref'd.
			childProcessOptions.stdio = 'ignore';
			childProcessOptions.detached = true;
		}
	}

	if (platform === 'darwin' && appArguments.length > 0) {
		cliArguments.push('--args', ...appArguments);
	}

	// IMPORTANT: On macOS, the target MUST come AFTER '--args'.
	// When using --args, ALL following arguments are passed to the app.
	// Example: open -a "chrome" --args --incognito https://site.com
	// This passes BOTH --incognito AND https://site.com to Chrome.
	// Without this order, Chrome won't open in incognito. See #332.
	if (options.target) {
		cliArguments.push(options.target);
	}

	const subprocess = childProcess.spawn(command, cliArguments, childProcessOptions);

	if (options.wait) {
		return new Promise((resolve, reject) => {
			subprocess.once('error', reject);

			subprocess.once('close', exitCode => {
				if (!options.allowNonzeroExitCode && exitCode !== 0) {
					reject(new Error(`Exited with code ${exitCode}`));
					return;
				}

				resolve(subprocess);
			});
		});
	}

	// When we're in a fallback attempt, we need to detect launch failures before trying the next app.
	// Wait for the close event to check the exit code before unreffing.
	// The launcher (open/xdg-open/PowerShell) exits quickly (~10-30ms) even on success.

	/*
	The PowerShell launcher must ALWAYS be awaited until it closes, even when not waiting for the app. Do not change this to resolve on `spawn`. See #367.

	PowerShell needs a few hundred milliseconds before it runs `Start-Process`, and libuv puts non-detached children in a job object that kills them when the parent exits. So a CLI that exits right after `await open()` silently kills PowerShell before anything opens. The launched app itself survives, since the job object allows breakaway for grandchildren, and `Start-Process` returns as soon as it has launched the app, so this does not wait for the app.

	Before v11, piped stdio kept the parent alive until PowerShell exited, which hid this. Detaching the launcher instead is unverified (PowerShell would get no console), while waiting is what worked before.
	*/
	if (isFallbackAttempt || platform === 'win32' || shouldUseWindowsInWsl) {
		return new Promise((resolve, reject) => {
			subprocess.once('error', reject);

			subprocess.once('spawn', () => {
				// Keep error handler active for post-spawn errors
				subprocess.once('close', exitCode => {
					subprocess.off('error', reject);

					// Only fallback attempts check the exit code, to detect a missing app. Other launches never do when not waiting for the app.
					if (isFallbackAttempt && exitCode !== 0) {
						reject(new Error(`Exited with code ${exitCode}`));
						return;
					}

					subprocess.unref();
					resolve(subprocess);
				});
			});
		});
	}

	subprocess.unref();

	// Handle spawn errors before the caller can attach listeners.
	// This prevents unhandled error events from crashing the process.
	return new Promise((resolve, reject) => {
		subprocess.once('error', reject);

		// Wait for the subprocess to spawn before resolving.
		// This ensures the process is established before the caller continues,
		// preventing issues when process.exit() is called immediately after.
		subprocess.once('spawn', () => {
			subprocess.off('error', reject);
			resolve(subprocess);
		});
	});
};

const open = (target, options) => {
	if (typeof target !== 'string') {
		throw new TypeError('Expected a `target`');
	}

	return baseOpen({
		...options,
		target,
	});
};

const openApp = (name, options) => {
	if (typeof name !== 'string' && !Array.isArray(name)) {
		throw new TypeError('Expected a valid `name`');
	}

	const {arguments: appArguments = []} = options ?? {};
	if (appArguments !== undefined && appArguments !== null && !Array.isArray(appArguments)) {
		throw new TypeError('Expected `appArguments` as Array type');
	}

	return baseOpen({
		...options,
		app: {
			name,
			arguments: appArguments,
		},
	});
};

function detectArchBinary(binary) {
	if (typeof binary === 'string' || Array.isArray(binary)) {
		return binary;
	}

	const {[arch]: archBinary} = binary;

	if (!archBinary) {
		throw new Error(`${arch} is not supported`);
	}

	return archBinary;
}

function detectPlatformBinary({[platform]: platformBinary}, {wsl} = {}) {
	if (wsl && isWsl$1) {
		return detectArchBinary(wsl);
	}

	if (!platformBinary) {
		throw new Error(`${platform} is not supported`);
	}

	return detectArchBinary(platformBinary);
}

const apps = {
	browser: 'browser',
	browserPrivate: 'browserPrivate',
};

defineLazyProperty(apps, 'chrome', () => detectPlatformBinary({
	darwin: 'google chrome',
	win32: 'chrome',
	// `chromium-browser` is the older deb package name used by Ubuntu/Debian before snap.
	linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
}, {
	wsl: {
		ia32: '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		x64: ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
	},
}));

defineLazyProperty(apps, 'brave', () => detectPlatformBinary({
	darwin: 'brave browser',
	win32: 'brave',
	linux: ['brave-browser', 'brave'],
}, {
	wsl: {
		ia32: '/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
		x64: ['/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', '/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe'],
	},
}));

defineLazyProperty(apps, 'firefox', () => detectPlatformBinary({
	darwin: 'firefox',
	win32: String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`,
	linux: 'firefox',
}, {
	wsl: '/mnt/c/Program Files/Mozilla Firefox/firefox.exe',
}));

defineLazyProperty(apps, 'edge', () => detectPlatformBinary({
	darwin: 'microsoft edge',
	win32: 'msedge',
	linux: ['microsoft-edge', 'microsoft-edge-dev'],
}, {
	wsl: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
}));

defineLazyProperty(apps, 'safari', () => detectPlatformBinary({
	darwin: 'Safari',
}));

export { apps, open as default, openApp };
//# sourceMappingURL=open-BxpcnChj.js.map
