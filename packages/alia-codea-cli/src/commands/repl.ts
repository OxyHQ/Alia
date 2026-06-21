import React from 'react';
import { render } from 'ink';
import { App, AppOptions } from '../app.js';
import { parseApprovalMode } from '../utils/approval.js';

interface ReplOptions {
  model: string;
  context: boolean;
  approvalMode?: string;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const appOptions: AppOptions = {
    model: options.model,
    approvalMode: parseApprovalMode(options.approvalMode),
    context: options.context,
  };

  const { waitUntilExit } = render(React.createElement(App, { options: appOptions }));
  await waitUntilExit();
}
