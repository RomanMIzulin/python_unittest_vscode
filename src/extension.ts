// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { LanguageClient, RequestType } from 'vscode-languageclient/node';
import { registerLogger, traceError, traceLog, traceVerbose } from './common/log/logging';
import {
    checkVersion,
    getInterpreterDetails,
    initializePython,
    onDidChangePythonInterpreter,
    resolveInterpreter,
} from './common/python';
import { restartServer } from './common/server';
import { checkIfConfigurationChanged, getInterpreterFromSetting } from './common/settings';
import { loadServerDefaults } from './common/setup';
import { getLSClientTraceLevel } from './common/utilities';
import { createOutputChannel, onDidChangeConfiguration, registerCommand } from './common/vscodeapi';

interface ReadFileParams {
    uri: string;
    lineNumber: number;
    isPytest: boolean;
}

namespace GenTestRequest {
    export const type = new RequestType<ReadFileParams, string, void>('gen_back');
}

let lsClient: LanguageClient | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // This is required to get server name and module. This should be
    // the first thing that we do in this extension.
    const serverInfo = loadServerDefaults();
    const serverName = serverInfo.name;
    const serverId = serverInfo.module;

    // Setup logging
    const outputChannel = createOutputChannel(serverName);
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));
    // let uri: vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri;
    // Get the active text editor
    let editor = vscode.window.activeTextEditor;
    let uri: vscode.Uri | undefined;
    let lineNumber: number | undefined;
    // Check if there is an active text editor
    if (editor) {
        // Get the current cursor position
        const position = editor.selection.active;

        // Set the line number of the current cursor position to the lineNumber variable
        lineNumber = position.line;
        // Get the URI of the current document
        uri = editor.document.uri;

        // Log the URI and line number
        console.log(`URI: ${uri.toString()}, Line Number: ${lineNumber}`);
    }
    const changeLogLevel = async (c: vscode.LogLevel, g: vscode.LogLevel) => {
        const level = getLSClientTraceLevel(c, g);
        await lsClient?.setTrace(level);
    };

    let disposable = vscode.commands.registerCommand('unittest_generator.helloWorld', () => {
        let webviewPanel = vscode.window.createWebviewPanel('wtf', 'wtf', vscode.ViewColumn.One);
        webviewPanel.webview.html = '<h1>hello</h1>';
        // webviewPanel.reveal(vscode.ViewColumn.One);
    });

    let genCommand = vscode.commands.registerCommand('unittest_generator.gen', async () => {
        const editor = vscode.window.activeTextEditor;
        const position = editor?.selection.active;

        // Set the line number of the current cursor position to the lineNumber variable
        lineNumber = position?.line;
        // Get the URI of the current document
        uri = editor?.document.uri;
        if (uri === undefined) {
            vscode.window.showErrorMessage('No active text editor');
            return;
        }
        let resp = await lsClient?.sendRequest(GenTestRequest.type, {
            uri: lsClient.code2ProtocolConverter.asUri(uri),
            lineNumber: lineNumber,
            isPytest: false,
        });
        traceLog(resp);
        // Create a new untitled document
        const doc = await vscode.workspace.openTextDocument({ language: 'python', content: resp });

        // Open the document in a new tab
        await vscode.window.showTextDocument(doc, { preview: false });
    });
    let genPytestCommand = vscode.commands.registerCommand('unittest_generator.gen_pytest', async () => {
        const editor = vscode.window.activeTextEditor;
        const position = editor?.selection.active;

        // Set the line number of the current cursor position to the lineNumber variable
        lineNumber = position?.line;
        // Get the URI of the current document
        uri = editor?.document.uri;
        if (uri === undefined) {
            vscode.window.showErrorMessage('No active text editor');
            return;
        }
        let resp = await lsClient?.sendRequest(GenTestRequest.type, {
            uri: lsClient.code2ProtocolConverter.asUri(uri),
            lineNumber: lineNumber,
            isPytest: true,
        });
        traceLog(resp);
        // Create a new untitled document
        const doc = await vscode.workspace.openTextDocument({ language: 'python', content: resp });

        // Open the document in a new tab
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    context.subscriptions.push(
        outputChannel.onDidChangeLogLevel(async (e) => {
            await changeLogLevel(e, vscode.env.logLevel);
        }),
        vscode.env.onDidChangeLogLevel(async (e) => {
            await changeLogLevel(outputChannel.logLevel, e);
        }),
        disposable,
        genCommand,
        genPytestCommand,
    );

    // Log Server information
    traceLog(`Name: ${serverInfo.name}`);
    traceLog(`Module: ${serverInfo.module}`);
    traceVerbose(`Full Server Info: ${JSON.stringify(serverInfo)}`);

    const runServer = async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter && interpreter.length > 0) {
            if (checkVersion(await resolveInterpreter(interpreter))) {
                traceVerbose(`Using interpreter from ${serverInfo.module}.interpreter: ${interpreter.join(' ')}`);
                lsClient = await restartServer(serverId, serverName, outputChannel, lsClient);
            }
            return;
        }

        const interpreterDetails = await getInterpreterDetails();
        if (interpreterDetails.path) {
            traceVerbose(`Using interpreter from Python extension: ${interpreterDetails.path.join(' ')}`);
            lsClient = await restartServer(serverId, serverName, outputChannel, lsClient);
            return;
        }

        traceError(
            'Python interpreter missing:\r\n' +
                '[Option 1] Select python interpreter using the ms-python.python.\r\n' +
                `[Option 2] Set an interpreter using "${serverId}.interpreter" setting.\r\n` +
                'Please use Python 3.7 or greater.',
        );
    };

    context.subscriptions.push(
        onDidChangePythonInterpreter(async () => {
            await runServer();
        }),
        onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
            if (checkIfConfigurationChanged(e, serverId)) {
                await runServer();
            }
        }),
        registerCommand(`${serverId}.restart`, async () => {
            await runServer();
        }),
    );

    setImmediate(async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter === undefined || interpreter.length === 0) {
            traceLog(`Python extension loading`);
            await initializePython(context.subscriptions);
            traceLog(`Python extension loaded`);
        } else {
            await runServer();
        }
    });
}

export async function deactivate(): Promise<void> {
    if (lsClient) {
        await lsClient.stop();
    }
}
