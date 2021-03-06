import * as vscode from 'vscode';
import { Disposable, TextDocument, Uri, workspace } from 'vscode';
import * as lc from 'vscode-languageclient/node';
import { Dove, getServerInitOptsFromMetadata } from './dove';
import { createLanguageServerClient } from './client';
import { isMoveDocument, log, uriExists } from './util';
import { activateTaskProvider } from './tasks';
import { bootstrap } from './bootstrap';
import { PersistentState } from './persistent_state';

async function isDoveInitializedProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const tomlFileUri = Uri.joinPath(folder.uri, 'Dove.toml');
    return uriExists(tomlFileUri);
}

export class ClientWorkspaceFactory implements Disposable {
    /**
     * Tracks the most current VSCode workspace as opened by the user. Used by the
     * commands to know in which workspace these should be executed.
     */
    activeWorkspace: ClientWorkspace | null = null;

    // Don't use URI as it's unreliable the same path might not become the same URI.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    private readonly workspaces: Map<vscode.WorkspaceFolder, ClientWorkspace> = new Map();
    private doveExecutable: string | null = null;
    private languageServerExecutable: string | null = null;

    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly state: PersistentState
    ) {}

    async initClientWorkspace(text_document: TextDocument | undefined) {
        if (!text_document) return;

        const folder = workspace.getWorkspaceFolder(text_document.uri);
        if (!folder) return;

        if (!(await isDoveInitializedProject(folder))) {
            log.debug(`Not a Dove project root: ${folder.uri.fsPath}`);
            return;
        }

        if (this.doveExecutable == null || this.languageServerExecutable == null) {
            const execs = await bootstrap(this.extensionContext, this.state);

            this.doveExecutable = execs.doveExecutablePath;
            log.debug(`Set ClientWorkspaceFactory.doveExecutable to ${this.doveExecutable}`);

            this.languageServerExecutable = execs.languageServerPath;
            log.debug(
                `Set ClientWorkspaceFactory.languageServerExecutable to ${this.languageServerExecutable}`
            );
        }

        log.debug(`initClientWorkspace called inside ${folder.uri.fsPath}`);
        let ws = this.workspaces.get(folder);
        if (!ws && isMoveDocument(text_document)) {
            ws = new ClientWorkspace(
                folder,
                this.extensionContext,
                this.languageServerExecutable
            );
            this.workspaces.set(folder, ws);

            const dove = new Dove(this.doveExecutable);
            const metadata = await dove.metadata(folder);
            if (!metadata) return;
            // let dove: Dove | undefined = undefined;
            // if (await isDoveInitializedProject(folder)) {
            //     dove = new Dove(this.doveExecutable, ExtensionSettings.logTrace);
            // }
            await ws.start(dove);
        }
        if (ws) {
            this.activeWorkspace = ws;
        }
    }

    dispose() {
        log.debug('Disposing ClientWorkspaceFactory');
        return Promise.all([...this.workspaces.values()].map((ws) => ws.stop()));
    }
}

// We run a single server/client pair per workspace folder.
// This class contains all the per-client and per-workspace stuff.
export class ClientWorkspace {
    private readonly disposables: Disposable[] = [];
    private readonly languageClients: lc.LanguageClient[] = [];

    constructor(
        readonly folder: vscode.WorkspaceFolder,
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly languageServerPath: string
    ) {}

    async start(dove: Dove) {
        log.debug(`Starting new ClientWorkspace instance at ${this.folder.uri.toString()}`);

        const metadata = await dove.metadataWithErrorMessage(this.folder);
        if (!metadata) return;

        const serverInitOpts = getServerInitOptsFromMetadata(metadata);
        const client = createLanguageServerClient(
            this.languageServerPath,
            this.folder,
            serverInitOpts
        );
        this.languageClients.push(client);
        this.disposables.push(client.start());

        this.disposables.push(activateTaskProvider(this.folder, dove.executable));
    }

    async stop(): Promise<any> {
        log.debug(`Stopping language clients for "${this.folder.uri.toString()}"`);
        for (const client of this.languageClients) {
            await client.stop();
        }

        log.debug(`Disposing ClientWorkspace for "${this.folder.uri.toString()}"`);
        this.disposables.forEach((d) => void d.dispose());
    }
}
