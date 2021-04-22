import * as vscode from 'vscode';
import { ExtensionContext, Uri } from 'vscode';
import { PersistentState } from './persistent_state';
import { assert, isValidExecutable, log, uriExists } from './util';
import { ExtensionSettings } from './settings';
import * as os from 'os';
import { download, downloadWithRetryDialog, fetchRelease } from './net';

function getPlatformLabel(name: NodeJS.Platform): string | undefined {
    if (name === 'win32') return 'win';
    if (name == 'linux') return 'linux';
    if (name == 'darwin') return 'mac';
    return undefined;
}

export async function bootstrap(
    context: ExtensionContext,
    state: PersistentState
): Promise<[string, string]> {
    const handleError = (binary: string, err: any) => {
        let message = 'bootstrap error. ';

        if (err.code === 'EBUSY' || err.code === 'ETXTBSY' || err.code === 'EPERM') {
            message += `Other vscode windows might be using ${binary}, `;
            message += 'you should close them and reload this window to retry. ';
        }

        if (!ExtensionSettings.logTrace) {
            message += 'To enable verbose logs use { "move.trace.extension": true }';
        }

        log.error('Bootstrap error', err);
        throw new Error(message);
    };

    const languageServerPath = await bootstrapLanguageServer(context, state).catch(
        handleError.bind(null, 'move-language-server')
    );

    const doveExecutablePath = await bootstrapDoveExecutable(context, state).catch(
        handleError.bind(null, 'dove')
    );

    return [languageServerPath, doveExecutablePath];
}

export async function bootstrapLanguageServer(
    context: ExtensionContext,
    state: PersistentState
): Promise<string> {
    const path = await getBinaryPathEnsureExists(
        context,
        state,
        'move-language-server',
        'languageServerPath'
    );
    log.info('Using language server binary at', path);

    return path;
}

export async function bootstrapDoveExecutable(
    context: ExtensionContext,
    state: PersistentState
): Promise<string> {
    const path = await getBinaryPathEnsureExists(context, state, 'dove', 'doveExecutablePath');
    log.info('Using dove binary at', path);

    if (!isValidExecutable(path)) {
        throw new Error(`Failed to execute ${path} --version`);
    }

    return path;
}

async function getBinaryPathEnsureExists(
    context: ExtensionContext,
    state: PersistentState,
    binaryName: string,
    configPath: string | null
): Promise<string> {
    if (configPath) {
        const explicitPath = ExtensionSettings.get<string>(configPath);
        if (explicitPath) {
            if (explicitPath.startsWith('~/')) {
                return os.homedir() + explicitPath.slice('~'.length);
            }
            return explicitPath;
        }
    }

    const platformLabel = getPlatformLabel(process.platform);
    if (platformLabel === undefined) {
        await vscode.window.showErrorMessage(
            "Unfortunately we don't ship binaries for your platform yet. "
        );
        throw new Error(`${binaryName} executable is not available.`);
    }
    const ext = platformLabel === 'win32' ? '.exe' : '';
    const releaseTag = '1.0.0';
    const fname = `${binaryName}-${releaseTag}-${platformLabel}${ext}`;
    const dest = Uri.joinPath(context.globalStorageUri, fname);
    if (await uriExists(dest)) {
        return dest.fsPath;
    }

    const release = await downloadWithRetryDialog(state, async () => {
        return await fetchRelease(releaseTag, state.githubToken);
    });
    const asset = release.assets.find(
        ({ browser_download_url, name }) =>
            name.startsWith(binaryName) && name.includes(platformLabel)
    );
    assert(!!asset, `Bad release: ${JSON.stringify(release)}`);

    await downloadWithRetryDialog(state, async () => {
        await download({
            url: asset.browser_download_url,
            dest: dest.fsPath,
            progressTitle: `Downloading "${binaryName}"`,
            mode: 0o755,
        });
    });

    return dest.fsPath;
}